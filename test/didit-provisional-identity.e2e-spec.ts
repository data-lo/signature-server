import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource, EntityManager } from 'typeorm';

import { MinioService } from './../src/common/minio/minio.service';
import { RedisService } from './../src/common/redis/redis.service';
import { ProcessDiditVerificationResultUseCase } from './../src/identity-verification/applications/process-didit-verification-result.use-case';
import { StoreVerifiedIdentityImagesUseCase } from './../src/identity-verification/applications/store-verified-identity-images.use-case';
import { UpdateSigningCredentialStatusUseCase } from './../src/identity-verification/applications/update-signing-credential-status.use-case';
import { DiditMediaDownloaderService } from './../src/identity-verification/didit/didit-media-downloader.service';
import { IdentityVerificationEntity } from './../src/identity-verification/entities/identity-verification.entity';
import { IdentityDocumentImagesProcessingException } from './../src/identity-verification/exceptions/identity-verification.exceptions';
import { AllowProvisionalPersonalInformation1784300000089 } from './../src/migrations/1784300000089-AllowProvisionalPersonalInformation';
import { PersonalInformationEntity } from './../src/user/entities/personal-information.entity';
import { UserEntity } from './../src/user/entities/user.entity';
import { insertProvisionedUser } from './../src/user/utils/insert-provisioned-user.util';

config({ path: join(__dirname, '..', '.env') });

/**
 * Bug "Crear personal_information para usuarios provisionales de integración".
 *
 * Los usuarios `PROVISIONED` nacían sin `personal_information`, y el webhook `Approved` de Didit
 * fallaba al guardar la INE ("el usuario no tiene información personal registrada"): la
 * verificación no pasaba a `APPROVED` y la credencial no avanzaba.
 *
 * Corre el procesamiento real del webhook (`ProcessDiditVerificationResultUseCase`, el guardado de
 * imágenes y la máquina de estados de la credencial) contra Postgres. Sólo se reemplaza lo externo:
 * la descarga de las imágenes desde Didit y MinIO.
 *
 * **No toca `signature_db`.** Crea una base propia (`signature_didit_provisional_e2e_*`) en el mismo
 * servidor de `POSTGRES_DB_URL`, le aplica todas las migraciones y la borra al terminar.
 */
describe('Webhook de Didit para usuarios provisionales (e2e)', () => {
  const DATABASE_NAME = `signature_didit_provisional_e2e_${process.pid}_${Date.now()}`;
  const baseUrl = process.env.POSTGRES_DB_URL as string;
  const adminUrl = baseUrl.replace(/\/[^/?]+(\?.*)?$/, '/postgres$1');
  const databaseUrl = baseUrl.replace(
    /\/[^/?]+(\?.*)?$/,
    `/${DATABASE_NAME}$1`,
  );

  let dataSource: DataSource;
  let moduleRef: TestingModule;
  let processResult: ProcessDiditVerificationResultUseCase;
  /** Objetos que habría guardado MinIO, por llave. */
  const stored = new Map<string, Buffer>();

  async function adminQuery(sql: string): Promise<void> {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await adminQuery(`CREATE DATABASE "${DATABASE_NAME}"`);

    dataSource = new DataSource({
      type: 'postgres',
      url: databaseUrl,
      entities: [join(__dirname, '..', 'src', '**', '*.entity{.ts,.js}')],
      migrations: [join(__dirname, '..', 'src', 'migrations', '*{.ts,.js}')],
      migrationsTransactionMode: 'each',
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    @Module({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: databaseUrl,
          entities: [join(__dirname, '..', 'src', '**', '*.entity{.ts,.js}')],
        }),
        TypeOrmModule.forFeature([
          IdentityVerificationEntity,
          UserEntity,
          PersonalInformationEntity,
        ]),
      ],
      providers: [
        ProcessDiditVerificationResultUseCase,
        StoreVerifiedIdentityImagesUseCase,
        UpdateSigningCredentialStatusUseCase,
        {
          // Didit: devuelve una imagen JPEG mínima en vez de descargarla.
          provide: DiditMediaDownloaderService,
          useValue: {
            download: async () => ({
              content: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
              contentType: 'image/jpeg',
              extension: 'jpg',
            }),
          },
        },
        {
          provide: MinioService,
          useValue: {
            putSensitiveObject: async (
              _bucket: unknown,
              key: string,
              content: Buffer,
            ) => {
              stored.set(key, Buffer.from(content));
            },
            deleteSensitiveObject: async () => undefined,
          },
        },
        { provide: RedisService, useValue: { del: async () => undefined } },
      ],
    })
    class DiditProvisionalE2eModule {}

    moduleRef = await Test.createTestingModule({
      imports: [DiditProvisionalE2eModule],
    }).compile();

    processResult = moduleRef.get(ProcessDiditVerificationResultUseCase);
  });

  afterAll(async () => {
    await moduleRef?.close();
    await dataSource?.destroy();
    await adminQuery(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE_NAME}' AND pid <> pg_backend_pid()`,
    );
    await adminQuery(`DROP DATABASE IF EXISTS "${DATABASE_NAME}"`);
  });

  /** Lo que haría el aprovisionamiento real (integración o plataforma), en una transacción. */
  function provision(email: string): Promise<UserEntity> {
    return dataSource.transaction((manager: EntityManager) =>
      insertProvisionedUser(manager, {
        email,
        firstName: 'beto',
        lastName: 'ruiz',
      }),
    );
  }

  /**
   * Intento de Didit abierto y credencial esperando el veredicto, como queda el provisional tras
   * iniciar la verificación desde la firma pública.
   */
  async function openVerification(userId: string): Promise<string> {
    const sessionId = `didit-session-${randomUUID()}`;
    await dataSource.query(
      `UPDATE users SET signing_credential_status = 'IDENTITY_VERIFICATION_PENDING' WHERE id = $1`,
      [userId],
    );
    await dataSource.query(
      `INSERT INTO identity_verifications (user_id, provider, status, provider_session_id)
       VALUES ($1, 'DIDIT', 'IN_PROGRESS', $2)`,
      [userId, sessionId],
    );
    return sessionId;
  }

  /** Webhook `Approved` de Didit con las dos caras de la INE. */
  function approvedPayload(sessionId: string, userId: string) {
    return {
      session_id: sessionId,
      status: 'Approved',
      vendor_data: userId,
      decision: {
        id_verifications: [
          {
            front_image: 'https://media.didit.me/front.jpg',
            back_image: 'https://media.didit.me/back.jpg',
          },
        ],
      },
    };
  }

  async function stateOf(userId: string, sessionId: string) {
    const [row] = await dataSource.query(
      `SELECT u.signing_credential_status, u.identity_verified_at, u.personal_information_id,
              p.front_image_key, p.back_image_key, v.status AS verification_status
       FROM users u
       LEFT JOIN personal_information p ON p.id = u.personal_information_id
       JOIN identity_verifications v ON v.user_id = u.id AND v.provider_session_id = $2
       WHERE u.id = $1`,
      [userId, sessionId],
    );
    return row;
  }

  it('reproduce el bug: un provisional sin información personal hace fallar el webhook Approved', async () => {
    // Como nacían antes de la corrección: usuario PROVISIONED sin ficha.
    const [{ id: userId }] = await dataSource.query(
      `INSERT INTO users (first_name, last_name, email, roles, lifecycle_status, is_email_verified)
       VALUES ('Viejo', 'Provisional', $1, '{SIGNER}', 'PROVISIONED', false) RETURNING id`,
      [`viejo-${randomUUID()}@cliente.test`],
    );
    const sessionId = await openVerification(userId);

    await expect(
      processResult.execute(approvedPayload(sessionId, userId)),
    ).rejects.toThrow(IdentityDocumentImagesProcessingException);

    // Nada avanzó: Didit reintentaría el webhook.
    expect(await stateOf(userId, sessionId)).toMatchObject({
      verification_status: 'IN_PROGRESS',
      signing_credential_status: 'IDENTITY_VERIFICATION_PENDING',
      identity_verified_at: null,
    });

    // El backfill de la migración 089 lo repara, y el reintento de Didit ya completa.
    await dataSource.transaction((manager) =>
      new AllowProvisionalPersonalInformation1784300000089().up(
        manager.queryRunner!,
      ),
    );
    await processResult.execute(approvedPayload(sessionId, userId));

    const repaired = await stateOf(userId, sessionId);
    expect(repaired.personal_information_id).not.toBeNull();
    expect(repaired).toMatchObject({
      verification_status: 'APPROVED',
      signing_credential_status: 'SIGNATURE_PENDING',
    });
    expect(repaired.front_image_key).toMatch(/front\.jpg$/);
    expect(repaired.back_image_key).toMatch(/back\.jpg$/);
  });

  it('un provisional nuevo nace con su información personal, sin CURP', async () => {
    const user = await provision(`nuevo-${randomUUID()}@cliente.test`);

    const [row] = await dataSource.query(
      `SELECT u.lifecycle_status, p.name, p.last_name, p.curp, p.rfc
       FROM users u JOIN personal_information p ON p.id = u.personal_information_id
       WHERE u.id = $1`,
      [user.id],
    );
    expect(row).toEqual({
      lifecycle_status: 'PROVISIONED',
      name: 'Beto',
      last_name: 'Ruiz',
      curp: null,
      rfc: null,
    });
  });

  it('el webhook Approved guarda las dos imágenes, aprueba y lleva la credencial a SIGNATURE_PENDING', async () => {
    const user = await provision(`aprobado-${randomUUID()}@cliente.test`);
    const sessionId = await openVerification(user.id);

    await processResult.execute(approvedPayload(sessionId, user.id));

    const state = await stateOf(user.id, sessionId);
    expect(state).toMatchObject({
      verification_status: 'APPROVED',
      signing_credential_status: 'SIGNATURE_PENDING',
    });
    expect(state.identity_verified_at).not.toBeNull();
    expect(state.front_image_key).toMatch(
      new RegExp(`^${user.personalInformationId}/.+/front\\.jpg$`),
    );
    expect(state.back_image_key).toMatch(
      new RegExp(`^${user.personalInformationId}/.+/back\\.jpg$`),
    );
    expect(stored.has(state.front_image_key)).toBe(true);
    expect(stored.has(state.back_image_key)).toBe(true);
  });

  it('con rúbrica ya registrada, la credencial termina en CONFIGURED', async () => {
    const user = await provision(`con-rubrica-${randomUUID()}@cliente.test`);
    const [{ id: signatureId }] = await dataSource.query(
      `INSERT INTO signatures DEFAULT VALUES RETURNING id`,
    );
    await dataSource.query(`UPDATE users SET signature_id = $2 WHERE id = $1`, [
      user.id,
      signatureId,
    ]);
    const sessionId = await openVerification(user.id);

    await processResult.execute(approvedPayload(sessionId, user.id));

    expect(await stateOf(user.id, sessionId)).toMatchObject({
      verification_status: 'APPROVED',
      signing_credential_status: 'CONFIGURED',
    });
  });

  /**
   * Si el usuario no se puede crear (aquí, un correo repetido), la transacción se revierte entera:
   * no queda una ficha huérfana.
   */
  it('es atómico: si el usuario no se crea, tampoco queda su información personal', async () => {
    const email = `repetido-${randomUUID()}@cliente.test`;
    await provision(email);
    const [{ count: before }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM personal_information`,
    );

    await expect(provision(email)).rejects.toThrow(/duplicate key/);

    const [{ count: after }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM personal_information`,
    );
    expect(after).toBe(before);
  });
});

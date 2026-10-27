import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { join } from 'path';
import { Client } from 'pg';
import * as request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AccountEntity } from './../src/account/entities/account.entity';
import { ApiKeySecretService } from './../src/api-key/api-key-secret.service';
import { ApiKeyModule } from './../src/api-key/api-key.module';
import { JwtAuthGuard } from './../src/auth/guards/jwt-auth.guard';
import { AuthorizationModule } from './../src/authorization/authorization.module';
import { applyGlobalApiPrefix } from './../src/common/constants/api-prefix.constants';
import { RedisService } from './../src/common/redis/redis.service';
import {
  CreateDocumentSignatureFlowUseCase,
  DocumentCreationOrigin,
} from './../src/document/applications/create-document-signature-flow.use-case';
import { DocumentService } from './../src/document/document.service';
import { CollaboratorEntity } from './../src/document/entities/collaborator.entity';
import { DocumentEntity } from './../src/document/entities/document.entity';
import { CreateIntegrationDocumentUseCase } from './../src/document/integration/applications/create-integration-document.use-case';
import { ListOrganizationIntegrationDocumentsUseCase } from './../src/document/integration/applications/list-organization-integration-documents.use-case';
import { ListUserIntegrationDocumentsUseCase } from './../src/document/integration/applications/list-user-integration-documents.use-case';
import { INTEGRATION_API_KEY_SECURITY } from './../src/document/integration/docs/api-integration-documents-common.docs';
import { IntegrationIdempotencyKeyEntity } from './../src/document/integration/entities/integration-idempotency-key.entity';
import { IntegrationDocumentsController } from './../src/document/integration/integration-documents.controller';
import { IntegrationIdempotencyService } from './../src/document/integration/services/integration-idempotency.service';
import { DocumentReadService } from './../src/document/services/document-read.service';

config({ path: join(__dirname, '..', '.env') });

const API_KEY_PEPPER =
  'pepper-de-la-e2e-de-integracion-con-mas-de-32-caracteres';

/**
 * `JwtAuthGuard` y `PermissionsGuard` reales como guards globales, en el mismo orden que en
 * `AppModule`: así se comprueba que la API de integración NO depende de ellos (`@SkipJwtAuth()` y
 * sin `@RequirePermission`), no sólo que funciona sin ellos.
 */
@Module({
  imports: [JwtModule.register({ secret: 'jwt-secret-e2e-integracion' })],
  providers: [
    {
      provide: RedisService,
      useValue: { exists: async () => false, get: async () => null },
    },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
class E2eJwtModule {}

/**
 * API de integración de documentos de punta a punta, contra Postgres de verdad.
 *
 * Es real todo lo que decide la seguridad y la idempotencia: `OrganizationApiKeyGuard` contra
 * `api_keys`/`api_key_permissions`, el aislamiento por organización de `DocumentReadService`, la
 * membresía del usuario consultado y la clave de idempotencia con su índice único dentro de la
 * transacción. Lo único reemplazado es `CreateDocumentSignatureFlowUseCase`, que necesita MinIO,
 * Kafka, el PDF y facturación: el doble inserta el documento en una transacción real, llama al
 * gancho del origen ANTES de "cobrar" —como el flujo real, cubierto por su propio spec— y cuenta
 * los cobros.
 *
 * **No toca `signature_db`.** Crea una base propia (`signature_integration_e2e_*`) en el mismo
 * servidor de `POSTGRES_DB_URL`, le aplica todas las migraciones y la borra al terminar.
 */
describe('API de integración de documentos (e2e)', () => {
  const DATABASE_NAME = `signature_integration_e2e_${process.pid}_${Date.now()}`;
  const baseUrl = process.env.POSTGRES_DB_URL as string;
  const adminUrl = baseUrl.replace(/\/[^/?]+(\?.*)?$/, '/postgres$1');
  const databaseUrl = baseUrl.replace(
    /\/[^/?]+(\?.*)?$/,
    `/${DATABASE_NAME}$1`,
  );

  /** Organizaciones, usuarios, membresías, permisos y llaves sembrados. */
  const ids: Record<string, string> = {};
  /** Llaves completas en claro, como las tendría el sistema externo. */
  const keys: Record<string, string> = {};
  /** Cuántas veces el doble del flujo "cobró" un crédito. */
  let creditsCharged = 0;

  let app: INestApplication;
  let dataSource: DataSource;
  let secrets: ApiKeySecretService;
  let swagger: OpenAPIObject;

  async function adminQuery(sql: string): Promise<void> {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  async function seedOrganization(key: string, isActive = true) {
    const [organization] = await dataSource.query(
      `INSERT INTO organizations (name, display_name, is_active) VALUES ($1, $1, $2) RETURNING id`,
      [`Org ${key}`, isActive],
    );
    ids[`org:${key}`] = organization.id;
  }

  /**
   * Siembra un usuario y su membresía en una organización.
   *
   * @param userKey - Nombre con el que la prueba se refiere al usuario.
   * @param organizationKey - Organización de la membresía.
   * @param isActive - `false` para una membresía dada de baja.
   * @returns Nada; deja `user:<userKey>` y `account:<userKey>` en `ids`.
   *
   * @example
   * ```ts
   * await seedMember('ana', 'org1');
   * ```
   */
  async function seedMember(
    userKey: string,
    organizationKey: string,
    isActive = true,
  ): Promise<void> {
    const [info] = await dataSource.query(
      `INSERT INTO personal_information (name, last_name, curp) VALUES ($1, 'E2E', $2) RETURNING id`,
      [userKey, `CURP${userKey}`.slice(0, 18)],
    );
    const [user] = await dataSource.query(
      `INSERT INTO users (first_name, last_name, email, roles, national_id, password, personal_information_id)
       VALUES ($1, 'E2E', $2, 'user', $3, 'x', $4) RETURNING id`,
      [userKey, `${userKey}@integration-e2e.test`, `NID${userKey}`, info.id],
    );
    const [account] = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, organization_id, role_id, email, password, is_active)
       SELECT $1, 'ORGANIZATION', $2, r.id, $3, 'x', $4 FROM roles r WHERE r.name = 'OWNER' AND r.is_system_role = true
       RETURNING id`,
      [
        user.id,
        ids[`org:${organizationKey}`],
        `${userKey}@integration-e2e.test`,
        isActive,
      ],
    );
    ids[`user:${userKey}`] = user.id;
    ids[`account:${userKey}`] = account.id;
  }

  /** Id del permiso, creando recurso, acción y permiso si las migraciones no los sembraron. */
  async function permission(
    resource: string,
    action: string,
    scope: string,
  ): Promise<string> {
    await dataSource.query(
      `INSERT INTO resources (key, description) VALUES ($1, $1) ON CONFLICT (key) DO NOTHING`,
      [resource],
    );
    await dataSource.query(
      `INSERT INTO actions (key, description) VALUES ($1, $1) ON CONFLICT (key) DO NOTHING`,
      [action],
    );
    await dataSource.query(
      `INSERT INTO permissions (resource_id, action_id, scope)
       SELECT r.id, a.id, $3 FROM resources r, actions a WHERE r.key = $1 AND a.key = $2
       ON CONFLICT DO NOTHING`,
      [resource, action, scope],
    );
    const [row] = await dataSource.query(
      `SELECT p.id FROM permissions p JOIN resources r ON r.id = p.resource_id JOIN actions a ON a.id = p.action_id
       WHERE r.key = $1 AND a.key = $2 AND p.scope = $3`,
      [resource, action, scope],
    );
    return row.id;
  }

  /**
   * Emite una llave como lo haría `POST /organizations/:id/api-keys` y guarda la llave en claro.
   *
   * @param key - Nombre con el que la prueba se refiere a la llave.
   * @param options - Organización, actor, permisos y estado.
   * @returns Nada; deja `key:<key>` en `ids` y la llave en `keys`.
   *
   * @example
   * ```ts
   * await seedApiKey('org1-full', { organizationKey: 'org1', actorKey: 'ana', permissions: ['read-org'] });
   * ```
   */
  async function seedApiKey(
    key: string,
    options: {
      organizationKey: string;
      actorKey: string;
      permissions: string[];
      status?: 'ACTIVE' | 'REVOKED';
      expiresAt?: Date | null;
      createdAt?: Date;
    },
  ): Promise<void> {
    const generated = secrets.generate();
    const status = options.status ?? 'ACTIVE';
    const [apiKey] = await dataSource.query(
      `INSERT INTO api_keys (organization_id, created_by_account_id, public_id, key_prefix, secret_hash, name, status, created_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        ids[`org:${options.organizationKey}`],
        ids[`account:${options.actorKey}`],
        generated.publicId,
        generated.keyPrefix,
        generated.secretHash,
        `Integración ${key}`,
        status,
        options.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
        options.expiresAt ?? null,
        status === 'REVOKED' ? new Date() : null,
      ],
    );
    for (const permissionKey of options.permissions) {
      await dataSource.query(
        `INSERT INTO api_key_permissions (api_key_id, permission_id) VALUES ($1, $2)`,
        [apiKey.id, ids[`permission:${permissionKey}`]],
      );
    }
    ids[`key:${key}`] = apiKey.id;
    keys[key] = generated.key;
  }

  /** Siembra un documento creado por un miembro, en su organización. */
  async function seedDocument(
    key: string,
    creatorKey: string,
    organizationKey: string,
    overrides: { status?: string; createdAt?: string } = {},
  ): Promise<void> {
    const [document] = await dataSource.query(
      `INSERT INTO documents (object_key, file_name, file_type, total_pages, ip_address, original_hash, status, created_by, account_id, organization_id, total_signers, signature_type, created_at)
       VALUES ($1, $2, 'application/pdf', 1, '127.0.0.1', 'hash', $3, $4, $5, $6, 1, 'SIMPLE', $7) RETURNING id`,
      [
        `${key}.pdf`,
        `${key}.pdf`,
        overrides.status ?? 'PENDING_SIGNATURE',
        ids[`user:${creatorKey}`],
        ids[`account:${creatorKey}`],
        ids[`org:${organizationKey}`],
        overrides.createdAt ?? '2026-06-01T00:00:00.000Z',
      ],
    );
    ids[`doc:${key}`] = document.id;
  }

  function api(key: string) {
    return { 'X-API-Key': keys[key] };
  }

  /**
   * Doble de `CreateDocumentSignatureFlowUseCase`: misma firma, una transacción real, el gancho del
   * origen antes del "cobro", y el documento con el autor, la cuenta y la llave que recibe.
   */
  const fakeFlow = {
    async execute(
      createdBy: string,
      accountId: string,
      dto: { documentData: { fileName: string } },
      file: Express.Multer.File,
      ip: string,
      origin?: DocumentCreationOrigin,
    ) {
      const document = await dataSource.transaction(
        async (manager: EntityManager) => {
          const [account] = await manager.query(
            `SELECT organization_id FROM accounts WHERE id = $1 AND user_id = $2 AND is_active`,
            [accountId, createdBy],
          );
          const saved = await manager.getRepository(DocumentEntity).save(
            manager.getRepository(DocumentEntity).create({
              objectKey: `${randomUUID()}.pdf`,
              fileName: dto.documentData.fileName,
              fileType: file.mimetype,
              totalPages: 1,
              ipAddress: ip,
              originalHash: 'hash',
              status: 'PENDING_SIGNATURE' as never,
              createdBy,
              accountId,
              organizationId: account.organization_id,
              totalSigners: 1,
              signatureType: 'SIMPLE' as never,
              createdViaApiKeyId: origin?.apiKeyId ?? null,
            }),
          );
          await origin?.onDocumentSaved?.(manager, saved);
          creditsCharged += 1;
          return saved;
        },
      );
      return { success: true, message: 'ok', data: { id: document.id } };
    },
  };

  const collaborators = JSON.stringify([
    {
      source: 'MANUAL',
      addToDirectory: false,
      collaboratorType: 'SIGNER',
      firstName: 'Juan',
      lastName: 'Pérez',
      email: 'juan.perez@cliente.test',
      signatures: [
        {
          page: 1,
          xRatio: 0.1,
          yRatio: 0.1,
          widthRatio: 0.2,
          heightRatio: 0.08,
        },
      ],
    },
  ]);

  function postDocument(
    keyName: string,
    idempotencyKey: string | null,
    options: { fileName?: string; pdf?: string; documentData?: object } = {},
  ) {
    const call = request(app.getHttpServer())
      .post('/api/v1/integration/documents')
      .set(api(keyName))
      .field(
        'documentData',
        JSON.stringify({
          fileName: options.fileName ?? 'contrato-erp.pdf',
          signatureType: 'SIMPLE',
          ...options.documentData,
        }),
      )
      .field('collaborators', collaborators)
      .attach('file', Buffer.from(options.pdf ?? '%PDF-1.4 erp'), {
        filename: 'contrato-erp.pdf',
        contentType: 'application/pdf',
      });
    return idempotencyKey ? call.set('Idempotency-Key', idempotencyKey) : call;
  }

  async function documentsCreatedVia(keyName: string): Promise<number> {
    const [{ count }] = await dataSource.query(
      `SELECT count(*)::int AS count FROM documents WHERE created_via_api_key_id = $1`,
      [ids[`key:${keyName}`]],
    );
    return count;
  }

  beforeAll(async () => {
    process.env.API_KEY_PEPPER = API_KEY_PEPPER;
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
          DocumentEntity,
          CollaboratorEntity,
          AccountEntity,
          IntegrationIdempotencyKeyEntity,
        ]),
        E2eJwtModule,
        AuthorizationModule,
        ApiKeyModule,
      ],
      controllers: [IntegrationDocumentsController],
      providers: [
        ListOrganizationIntegrationDocumentsUseCase,
        ListUserIntegrationDocumentsUseCase,
        CreateIntegrationDocumentUseCase,
        DocumentReadService,
        IntegrationIdempotencyService,
        { provide: CreateDocumentSignatureFlowUseCase, useValue: fakeFlow },
        {
          provide: DocumentService,
          useValue: {
            resolveDocumentSignatureType:
              DocumentService.prototype.resolveDocumentSignatureType,
          },
        },
      ],
    })
    class IntegrationE2eModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [IntegrationE2eModule],
    }).compile();

    app = moduleRef.createNestApplication();
    applyGlobalApiPrefix(app);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    // La conexión de la app y la de la prueba son distintas; las dos apuntan a la misma base.
    dataSource = app.get(getDataSourceToken());
    secrets = app.get(ApiKeySecretService);

    swagger = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .addApiKey(
          { type: 'apiKey', name: 'X-API-Key', in: 'header' },
          INTEGRATION_API_KEY_SECURITY,
        )
        .build(),
    );

    await seedOrganization('org1');
    await seedOrganization('org2');
    await seedOrganization('org-off', false);
    await seedMember('ana', 'org1');
    await seedMember('beto', 'org1');
    await seedMember('dario', 'org1', false);
    await seedMember('carla', 'org2');
    await seedMember('olga', 'org-off');

    ids['permission:read-org'] = await permission(
      'DOCUMENT',
      'READ',
      'ORGANIZATION',
    );
    ids['permission:read-own'] = await permission('DOCUMENT', 'READ', 'OWN');
    ids['permission:create'] = await permission('DOCUMENT', 'CREATE', 'ANY');

    await seedApiKey('org1-full', {
      organizationKey: 'org1',
      actorKey: 'ana',
      permissions: ['read-org', 'create'],
    });
    await seedApiKey('org1-own', {
      organizationKey: 'org1',
      actorKey: 'ana',
      permissions: ['read-own'],
      status: 'REVOKED',
    });
    await seedApiKey('org1-revoked', {
      organizationKey: 'org1',
      actorKey: 'ana',
      permissions: ['read-org'],
      status: 'REVOKED',
    });
    await seedApiKey('org2-full', {
      organizationKey: 'org2',
      actorKey: 'carla',
      permissions: ['read-org', 'create'],
    });
    await seedApiKey('org-off', {
      organizationKey: 'org-off',
      actorKey: 'olga',
      permissions: ['read-org'],
    });

    await seedDocument('ana-1', 'ana', 'org1', {
      createdAt: '2026-03-01T00:00:00.000Z',
    });
    await seedDocument('ana-2', 'ana', 'org1', { status: 'SIGNED' });
    await seedDocument('beto-1', 'beto', 'org1');
    await seedDocument('carla-1', 'carla', 'org2');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await adminQuery(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE_NAME}' AND pid <> pg_backend_pid()`,
    );
    await adminQuery(`DROP DATABASE IF EXISTS "${DATABASE_NAME}"`);
  });

  /** Cambia cuál de las llaves de org1 está activa: el índice parcial sólo admite una. */
  async function activateOnly(keyName: string): Promise<void> {
    await dataSource.query(
      `UPDATE api_keys SET status = 'REVOKED', revoked_at = now() WHERE organization_id = $1 AND id <> $2`,
      [ids['org:org1'], ids[`key:${keyName}`]],
    );
    await dataSource.query(
      `UPDATE api_keys SET status = 'ACTIVE', revoked_at = NULL, revoked_by_account_id = NULL WHERE id = $1`,
      [ids[`key:${keyName}`]],
    );
  }

  beforeEach(() => activateOnly('org1-full'));

  describe('autenticación', () => {
    it('no pide JWT ni X-Account-Id: basta la API key', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/integration/documents')
        .set(api('org1-full'))
        .expect(200);
    });

    it.each([
      ['sin X-API-Key', {}],
      [
        'con la llave interna de process.env.API_KEY',
        { 'X-API-Key': 'replace-with-a-long-random-string' },
      ],
      [
        'con un JWT en vez de la llave',
        { Authorization: 'Bearer cualquier.cosa.aqui' },
      ],
    ])('responde 401 API_KEY_INVALID %s', async (_label, headers) => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/integration/documents')
        .set(headers)
        .expect(401);
      expect(response.body.code).toBe('API_KEY_INVALID');
    });

    it('responde 401 a una llave revocada', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/integration/documents')
        .set(api('org1-revoked'))
        .expect(401);
      expect(response.body.code).toBe('API_KEY_INVALID');
    });

    it('responde 401 API_KEY_EXPIRED a una llave vencida', async () => {
      await dataSource.query(
        `UPDATE api_keys SET expires_at = '2026-02-01T00:00:00.000Z' WHERE id = $1`,
        [ids['key:org1-full']],
      );
      try {
        const response = await request(app.getHttpServer())
          .get('/api/v1/integration/documents')
          .set(api('org1-full'))
          .expect(401);
        expect(response.body.code).toBe('API_KEY_EXPIRED');
      } finally {
        await dataSource.query(
          `UPDATE api_keys SET expires_at = NULL WHERE id = $1`,
          [ids['key:org1-full']],
        );
      }
    });

    it('responde 403 si la organización de la llave está desactivada', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/integration/documents')
        .set(api('org-off'))
        .expect(403);
      expect(response.body.code).toBe('API_KEY_ORGANIZATION_INACTIVE');
    });

    it('responde 403 si el actor de la llave ya no es miembro activo', async () => {
      await dataSource.query(
        `UPDATE accounts SET is_active = false WHERE id = $1`,
        [ids['account:carla']],
      );
      try {
        const response = await request(app.getHttpServer())
          .get('/api/v1/integration/documents')
          .set(api('org2-full'))
          .expect(403);
        expect(response.body.code).toBe('API_KEY_ACTOR_INACTIVE');
      } finally {
        await dataSource.query(
          `UPDATE accounts SET is_active = true WHERE id = $1`,
          [ids['account:carla']],
        );
      }
    });

    it('registra el último uso exitoso de la llave', async () => {
      await dataSource.query(
        `UPDATE api_keys SET last_used_at = NULL WHERE id = $1`,
        [ids['key:org1-full']],
      );

      await request(app.getHttpServer())
        .get('/api/v1/integration/documents')
        .set(api('org1-full'))
        .expect(200);

      const [row] = await dataSource.query(
        `SELECT last_used_at FROM api_keys WHERE id = $1`,
        [ids['key:org1-full']],
      );
      expect(row.last_used_at).toBeInstanceOf(Date);
    });
  });

  describe('GET /integration/documents', () => {
    it('devuelve sólo documentos de la organización de la llave, sin datos personales ni URL', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/integration/documents')
        .set(api('org1-full'))
        .expect(200);

      const items = response.body.data.items;
      expect(items.map((item: { id: string }) => item.id).sort()).toEqual(
        [ids['doc:ana-1'], ids['doc:ana-2'], ids['doc:beto-1']].sort(),
      );
      expect(Object.keys(items[0]).sort()).toEqual(
        [
          'createdAt',
          'fileName',
          'id',
          'signatureType',
          'signedAt',
          'status',
        ].sort(),
      );
      expect(response.body.data.pagination).toEqual({
        page: 1,
        limit: 25,
        total: 3,
        totalPages: 1,
      });
    });

    it('la otra organización ve sólo lo suyo con su propia llave', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/integration/documents')
        .set(api('org2-full'))
        .expect(200);

      expect(
        response.body.data.items.map((item: { id: string }) => item.id),
      ).toEqual([ids['doc:carla-1']]);
    });

    it('pagina y filtra por estatus y fecha', async () => {
      const paged = await request(app.getHttpServer())
        .get('/api/v1/integration/documents?limit=2&page=2')
        .set(api('org1-full'))
        .expect(200);
      expect(paged.body.data.items).toHaveLength(1);
      expect(paged.body.data.pagination).toMatchObject({
        page: 2,
        limit: 2,
        totalPages: 2,
      });

      const signed = await request(app.getHttpServer())
        .get('/api/v1/integration/documents?statuses=SIGNED')
        .set(api('org1-full'))
        .expect(200);
      expect(
        signed.body.data.items.map((item: { id: string }) => item.id),
      ).toEqual([ids['doc:ana-2']]);

      const early = await request(app.getHttpServer())
        .get('/api/v1/integration/documents?createdTo=2026-04-01T00:00:00.000Z')
        .set(api('org1-full'))
        .expect(200);
      expect(
        early.body.data.items.map((item: { id: string }) => item.id),
      ).toEqual([ids['doc:ana-1']]);
    });

    it('rechaza más de 100 documentos por página', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/integration/documents?limit=101')
        .set(api('org1-full'))
        .expect(400);
    });

    it.each([
      ['organizationId en el query', '?organizationId=ORG2', {}],
      ['accountId en el query', '?accountId=x', {}],
      ['taxId en el query', '?taxId=RFC', {}],
      ['X-Account-Id', '', { 'X-Account-Id': 'ACCOUNT_CARLA' }],
      ['X-Organization-Id', '', { 'X-Organization-Id': 'ORG2' }],
    ])(
      'rechaza con 400 %s, sin cruzar de organización',
      async (_label, query, headers) => {
        const resolve = (value: string) =>
          value
            .replace('ORG2', ids['org:org2'])
            .replace('ACCOUNT_CARLA', ids['account:carla']);
        const response = await request(app.getHttpServer())
          .get(`/api/v1/integration/documents${resolve(query)}`)
          .set(api('org1-full'))
          .set(
            Object.fromEntries(
              Object.entries(headers).map(([k, v]) => [k, resolve(v)]),
            ),
          )
          .expect(400);
        expect(response.body.code).toBe(
          'INTEGRATION_TENANT_OVERRIDE_NOT_ALLOWED',
        );
      },
    );

    it('responde 403 a una llave con sólo DOCUMENT.READ_OWN', async () => {
      await activateOnly('org1-own');

      const response = await request(app.getHttpServer())
        .get('/api/v1/integration/documents')
        .set(api('org1-own'))
        .expect(403);
      expect(response.body.code).toBe('API_KEY_PERMISSION_DENIED');
    });
  });

  describe('GET /integration/users/:userId/documents', () => {
    const userUrl = (userKey: string) =>
      `/api/v1/integration/users/${ids[`user:${userKey}`] ?? userKey}/documents`;

    it('con ORGANIZATION devuelve los documentos creados por cualquier miembro activo', async () => {
      const response = await request(app.getHttpServer())
        .get(userUrl('beto'))
        .set(api('org1-full'))
        .expect(200);

      expect(
        response.body.data.items.map((item: { id: string }) => item.id),
      ).toEqual([ids['doc:beto-1']]);
    });

    it.each([
      ['un usuario de otra organización', 'carla'],
      ['una membresía dada de baja', 'dario'],
      ['un usuario que no existe', randomUUID()],
      ['un id que no es UUID', 'no-es-uuid'],
    ])('responde 404 a %s, sin revelar nada', async (_label, userKey) => {
      const response = await request(app.getHttpServer())
        .get(userUrl(userKey))
        .set(api('org1-full'))
        .expect(404);
      expect(response.body.code).toBe('INTEGRATION_USER_NOT_FOUND');
    });

    it('con sólo OWN consulta al actor de la llave', async () => {
      await activateOnly('org1-own');

      const response = await request(app.getHttpServer())
        .get(userUrl('ana'))
        .set(api('org1-own'))
        .expect(200);
      expect(response.body.data.pagination.total).toBe(2);
    });

    it('con sólo OWN no puede consultar a otro usuario, ni de su organización', async () => {
      await activateOnly('org1-own');

      for (const userKey of ['beto', 'carla']) {
        const response = await request(app.getHttpServer())
          .get(userUrl(userKey))
          .set(api('org1-own'))
          .expect(403);
        expect(response.body.code).toBe('INTEGRATION_SCOPE_DENIED');
      }
    });
  });

  describe('POST /integration/documents', () => {
    it('crea el documento a nombre del actor de la llave, en su organización y vía la llave', async () => {
      const response = await postDocument(
        'org1-full',
        `alta-${randomUUID()}`,
      ).expect(201);

      expect(response.headers['idempotent-replayed']).toBe('false');
      expect(response.body.data).toMatchObject({
        fileName: 'contrato-erp.pdf',
        status: 'PENDING_SIGNATURE',
        signatureType: 'SIMPLE',
      });
      const [row] = await dataSource.query(
        `SELECT created_by, account_id, organization_id, created_via_api_key_id FROM documents WHERE id = $1`,
        [response.body.data.id],
      );
      expect(row).toEqual({
        created_by: ids['user:ana'],
        account_id: ids['account:ana'],
        organization_id: ids['org:org1'],
        created_via_api_key_id: ids['key:org1-full'],
      });
    });

    it('exige Idempotency-Key', async () => {
      const response = await postDocument('org1-full', null).expect(400);
      expect(response.body.code).toBe('INTEGRATION_IDEMPOTENCY_KEY_REQUIRED');
    });

    it('un reintento con la misma clave y contenido devuelve el mismo documento sin cobrar de nuevo', async () => {
      const idempotencyKey = `reintento-${randomUUID()}`;
      const before = creditsCharged;

      const first = await postDocument('org1-full', idempotencyKey).expect(201);
      const retry = await postDocument('org1-full', idempotencyKey).expect(200);

      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body.data.id).toBe(first.body.data.id);
      expect(creditsCharged - before).toBe(1);
    });

    it('la misma clave con otro archivo responde 409 y no crea nada', async () => {
      const idempotencyKey = `otro-archivo-${randomUUID()}`;
      await postDocument('org1-full', idempotencyKey).expect(201);
      const created = await documentsCreatedVia('org1-full');

      const response = await postDocument('org1-full', idempotencyKey, {
        pdf: '%PDF-1.4 otro contenido',
      }).expect(409);

      expect(response.body.code).toBe('INTEGRATION_IDEMPOTENCY_KEY_MISMATCH');
      await expect(documentsCreatedVia('org1-full')).resolves.toBe(created);
    });

    it('peticiones simultáneas con la misma clave crean un solo documento y cobran una vez', async () => {
      const idempotencyKey = `simultaneas-${randomUUID()}`;
      const before = creditsCharged;

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          postDocument('org1-full', idempotencyKey),
        ),
      );

      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 200, 200, 200, 201,
      ]);
      expect(
        new Set(responses.map((response) => response.body.data.id)).size,
      ).toBe(1);
      expect(creditsCharged - before).toBe(1);
      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int AS count FROM integration_idempotency_keys WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      expect(count).toBe(1);
    });

    it('la misma clave en otra organización es otra clave', async () => {
      const idempotencyKey = `compartida-${randomUUID()}`;

      const org1 = await postDocument('org1-full', idempotencyKey).expect(201);
      const org2 = await postDocument('org2-full', idempotencyKey).expect(201);

      expect(org2.body.data.id).not.toBe(org1.body.data.id);
    });

    it.each([
      ['organizationId', { organizationId: 'ORG2' }],
      ['createdByUserId', { createdByUserId: 'USER_CARLA' }],
      ['accountId', { accountId: 'ACCOUNT_CARLA' }],
    ])(
      'rechaza %s dentro de documentData sin crear nada',
      async (field, patch) => {
        const before = await documentsCreatedVia('org1-full');
        const resolved = Object.fromEntries(
          Object.entries(patch).map(([key, value]) => [
            key,
            value
              .replace('ORG2', ids['org:org2'])
              .replace('USER_CARLA', ids['user:carla'])
              .replace('ACCOUNT_CARLA', ids['account:carla']),
          ]),
        );

        const response = await postDocument(
          'org1-full',
          `tenant-${field}-${randomUUID()}`,
          {
            documentData: resolved,
          },
        ).expect(400);

        expect(response.body.code).toBe(
          'INTEGRATION_TENANT_OVERRIDE_NOT_ALLOWED',
        );
        await expect(documentsCreatedVia('org1-full')).resolves.toBe(before);
      },
    );

    it('rechaza createdBy en el body', async () => {
      const response = await postDocument('org1-full', `body-${randomUUID()}`)
        .field('createdBy', ids['user:carla'])
        .expect(400);
      expect(response.body.code).toBe(
        'INTEGRATION_TENANT_OVERRIDE_NOT_ALLOWED',
      );
    });

    it('responde 403 a una llave sin DOCUMENT.CREATE', async () => {
      await activateOnly('org1-own');

      const response = await postDocument(
        'org1-own',
        `sin-permiso-${randomUUID()}`,
      ).expect(403);
      expect(response.body.code).toBe('API_KEY_PERMISSION_DENIED');
    });
  });

  describe('documentación Swagger', () => {
    it.each([
      ['/api/v1/integration/documents', 'get', ['200', '400', '401', '403']],
      [
        '/api/v1/integration/users/{userId}/documents',
        'get',
        ['200', '400', '401', '403', '404'],
      ],
      [
        '/api/v1/integration/documents',
        'post',
        ['200', '201', '400', '401', '403', '409'],
      ],
    ])(
      '%s %s documenta X-API-Key y sus respuestas',
      (path, method, statuses) => {
        const operation = (
          swagger.paths[path] as Record<
            string,
            {
              responses: Record<string, unknown>;
              security?: unknown[];
              parameters?: { name: string; in: string }[];
            }
          >
        )?.[method];

        expect(operation).toBeDefined();
        expect(Object.keys(operation.responses).sort()).toEqual(
          statuses.sort(),
        );
        expect(operation.security).toEqual([
          { [INTEGRATION_API_KEY_SECURITY]: [] },
        ]);
        expect(
          operation.parameters?.map((parameter) => parameter.name),
        ).toContain('X-API-Key');
      },
    );

    it('la creación documenta Idempotency-Key y multipart', () => {
      const operation = (
        swagger.paths['/api/v1/integration/documents'] as Record<string, any>
      ).post;

      expect(
        operation.parameters.map(
          (parameter: { name: string }) => parameter.name,
        ),
      ).toContain('Idempotency-Key');
      expect(Object.keys(operation.requestBody.content)).toEqual([
        'multipart/form-data',
      ]);
    });
  });
});

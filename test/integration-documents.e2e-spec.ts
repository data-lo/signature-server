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
import { PDFDocument } from 'pdf-lib';
import { DataSource, EntityManager } from 'typeorm';

import { AccountMemberService } from './../src/account/account-member.service';
import { AccountService } from './../src/account/account.service';
import { AccountEntity } from './../src/account/entities/account.entity';
import { ApiKeySecretService } from './../src/api-key/api-key-secret.service';
import { ApiKeyModule } from './../src/api-key/api-key.module';
import { JwtAuthGuard } from './../src/auth/guards/jwt-auth.guard';
import { AuthorizationModule } from './../src/authorization/authorization.module';
import { applyGlobalApiPrefix } from './../src/common/constants/api-prefix.constants';
import { PdfSignatureService } from './../src/common/document-signing/document-signing.service';
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
import { IssueIntegrationSigningAccessUseCase } from './../src/document/integration/applications/issue-integration-signing-access.use-case';
import { ResendIntegrationSigningInvitationUseCase } from './../src/document/integration/applications/resend-integration-signing-invitation.use-case';
import { SigningInvitationDeliveryService } from './../src/signing-invitation/signing-invitation-delivery.service';
import {
  INTEGRATION_API_KEY_SECURITY,
  INTEGRATION_API_KEY_SECURITY_SCHEME,
} from './../src/document/integration/docs/api-integration-documents-common.docs';
import { createIntegrationOpenApiDocument } from './../src/document/integration/openapi/create-integration-openapi-document';
import { IntegrationIdempotencyKeyEntity } from './../src/document/integration/entities/integration-idempotency-key.entity';
import { IntegrationDocumentsController } from './../src/document/integration/integration-documents.controller';
import { IntegrationIdempotencyService } from './../src/document/integration/services/integration-idempotency.service';
import { IntegrationCreatorService } from './../src/document/integration/services/integration-creator.service';
import { IntegrationPayloadValidator } from './../src/document/integration/validation/integration-payload.validator';
import { OrganizationMemberEventsProducer } from './../src/kafka/organization-member.producer';
import { RolesModule } from './../src/roles/roles.module';
import { UserEntity } from './../src/user/entities/user.entity';
import { DocumentReadService } from './../src/document/services/document-read.service';

config({ path: join(__dirname, '..', '.env') });

const INTEGRATION_API_KEY_HMAC_SECRET =
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
/** Un PDF real con `pages` páginas en blanco. */
async function buildPdf(pages: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let page = 0; page < pages; page += 1) pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save());
}

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
  /** PDF real de 2 páginas que mandan las pruebas; `otherPdf` tiene 3. */
  let twoPagePdf: Buffer;
  let otherPdf: Buffer;
  /** Cuántas veces el doble del flujo "cobró" un crédito. */
  let creditsCharged = 0;
  /** Cuántas altas siguientes debe hacer fallar el doble del flujo (después del gancho). */
  let flowFailures = 0;
  /** Avisos `organization.member.joined` que habría publicado el alta de miembros. */
  let membersJoined = 0;
  /** Reenvíos de invitación que habría emitido y enviado `SigningInvitationDeliveryService`. */
  const delivered: {
    documentId: string;
    collaboratorId: string;
    apiKeyId?: string;
  }[] = [];

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
      dto: {
        documentData: { fileName: string };
        collaborators: { email: string; collaboratorType: string }[];
      },
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
          for (const collaborator of dto.collaborators) {
            await manager.query(
              `INSERT INTO collaborators (document_id, email, colaborator_type, ip_address) VALUES ($1, $2, $3, $4)`,
              [saved.id, collaborator.email, collaborator.collaboratorType, ip],
            );
          }
          if (flowFailures > 0) {
            flowFailures -= 1;
            throw new Error('fallo simulado del alta (p. ej. sin créditos)');
          }
          creditsCharged += 1;
          return saved;
        },
      );
      return { success: true, message: 'ok', data: { id: document.id } };
    },
  };

  const POSITION = {
    page: 1,
    xRatio: 0.1,
    yRatio: 0.1,
    widthRatio: 0.2,
    heightRatio: 0.08,
  };

  /** Payload del contrato de integración; `patch` ajusta lo que la prueba necesita. */
  function payload(patch: (value: Record<string, any>) => void = () => {}) {
    const value: Record<string, any> = {
      creator: {
        email: 'ana@integration-e2e.test',
        firstName: 'Ana',
        lastName: 'E2E',
      },
      document: {
        signatureType: 'SIMPLE',
        isSequential: true,
        isIndexable: true,
      },
      participants: [
        {
          role: 'SIGNER',
          firstName: 'Luis',
          lastName: 'Martínez',
          email: 'luis@correo.test',
          order: 1,
          signaturePositions: [{ ...POSITION }],
        },
        {
          role: 'WITNESS',
          firstName: 'Eva',
          lastName: 'Ruiz',
          email: 'eva@correo.test',
          order: 2,
        },
      ],
    };
    patch(value);
    return value;
  }

  function postDocument(
    keyName: string,
    idempotencyKey: string | null,
    options: {
      pdf?: Buffer | string;
      body?: Record<string, any> | string;
    } = {},
  ) {
    const body = options.body ?? payload();
    const call = request(app.getHttpServer())
      .post('/api/v1/integration/documents')
      .set(api(keyName))
      .field('payload', typeof body === 'string' ? body : JSON.stringify(body))
      .attach(
        'file',
        typeof options.pdf === 'string'
          ? Buffer.from(options.pdf)
          : (options.pdf ?? twoPagePdf),
        { filename: 'contrato-erp.pdf', contentType: 'application/pdf' },
      );
    return idempotencyKey ? call.set('Idempotency-Key', idempotencyKey) : call;
  }

  async function userByEmail(email: string) {
    const [user] = await dataSource.query(
      `SELECT id, first_name, lifecycle_status, password, national_id, personal_information_id FROM users WHERE email = $1`,
      [email],
    );
    return user;
  }

  async function accountsOf(userId: string) {
    return dataSource.query(
      `SELECT a.id, a.account_type, a.organization_id, a.is_active, a.password, r.name AS role
       FROM accounts a LEFT JOIN roles r ON r.id = a.role_id WHERE a.user_id = $1 ORDER BY a.account_type`,
      [userId],
    );
  }

  beforeAll(async () => {
    process.env.INTEGRATION_API_KEY_HMAC_SECRET =
      INTEGRATION_API_KEY_HMAC_SECRET;
    process.env.PUBLIC_WEB_APP_URL = 'https://app.firmalo.test/';
    twoPagePdf = await buildPdf(2);
    otherPdf = await buildPdf(3);
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
          UserEntity,
          IntegrationIdempotencyKeyEntity,
        ]),
        E2eJwtModule,
        AuthorizationModule,
        ApiKeyModule,
        RolesModule,
      ],
      controllers: [IntegrationDocumentsController],
      providers: [
        ListOrganizationIntegrationDocumentsUseCase,
        ListUserIntegrationDocumentsUseCase,
        CreateIntegrationDocumentUseCase,
        // Real: la regla de qué se puede reenviar, contra la base. La emisión y el correo, dobles.
        ResendIntegrationSigningInvitationUseCase,
        // La emisión de accesos temporales tiene su propia e2e (`signing-access-flow`).
        { provide: IssueIntegrationSigningAccessUseCase, useValue: {} },
        {
          provide: SigningInvitationDeliveryService,
          useValue: {
            deliver: async (input: {
              document: { id: string };
              collaborator: { id: string };
              auditActor: { apiKeyId?: string };
            }) => {
              delivered.push({
                documentId: input.document.id,
                collaboratorId: input.collaborator.id,
                apiKeyId: input.auditActor.apiKeyId,
              });
              return {
                invitationId: 'inv-e2e',
                expiresAt: new Date('2026-12-01T00:00:00.000Z'),
                emailDelivered: true,
              };
            },
          },
        },
        DocumentReadService,
        IntegrationIdempotencyService,
        IntegrationCreatorService,
        IntegrationPayloadValidator,
        // Real: la validación lee las páginas del PDF con el mismo servicio que el flujo.
        PdfSignatureService,
        AccountMemberService,
        {
          /**
           * Lo único de `AccountService` que usa el aprovisionamiento: la cuenta personal (con su rol
           * OWNER, como la real; el perfil Free de facturación queda fuera de esta prueba) y el
           * catálogo de Redis, que aquí no existe.
           */
          provide: AccountService,
          useValue: {
            createDefaultPersonalAccount: async (
              manager: EntityManager,
              userId: string,
              email: string,
              password: string | null,
            ) => {
              const [account] = await manager.query(
                `INSERT INTO accounts (user_id, account_type, organization_id, role_id, email, password)
                 SELECT $1, 'PERSONAL', NULL, r.id, $2, $3 FROM roles r WHERE r.name = 'OWNER' AND r.is_system_role = true
                 RETURNING id`,
                [userId, email, password],
              );
              return { account };
            },
            appendAccountToCatalog: async () => undefined,
          },
        },
        {
          provide: OrganizationMemberEventsProducer,
          useValue: {
            enqueueJoined: async () => {
              membersJoined += 1;
            },
            flushOutbox: async () => undefined,
          },
        },
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

    // El contrato que se publica a los clientes (`/api/v1/integration/docs`), no el general.
    swagger = createIntegrationOpenApiDocument(
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .addApiKey(
            INTEGRATION_API_KEY_SECURITY_SCHEME,
            INTEGRATION_API_KEY_SECURITY,
          )
          .build(),
      ),
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
      expect(response.body.error.code).toBe('API_KEY_INVALID');
    });

    it('responde 401 a una llave revocada', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/integration/documents')
        .set(api('org1-revoked'))
        .expect(401);
      expect(response.body.error.code).toBe('API_KEY_INVALID');
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
        expect(response.body.error.code).toBe('API_KEY_EXPIRED');
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
      expect(response.body.error.code).toBe('API_KEY_ORGANIZATION_INACTIVE');
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
        expect(response.body.error.code).toBe('API_KEY_ACTOR_INACTIVE');
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
        .expect(422)
        .expect((response) =>
          expect(response.body.error.code).toBe('INVALID_REQUEST'),
        );
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
        expect(response.body.error.code).toBe(
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
      expect(response.body.error.code).toBe('API_KEY_PERMISSION_DENIED');
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
      expect(response.body.error.code).toBe('INTEGRATION_USER_NOT_FOUND');
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
        expect(response.body.error.code).toBe('INTEGRATION_SCOPE_DENIED');
      }
    });
  });

  describe('GET /integration/documents?creatorEmail=', () => {
    const byEmail = (email: string) =>
      `/api/v1/integration/documents?creatorEmail=${encodeURIComponent(email)}`;

    it('con ORGANIZATION devuelve sólo los documentos de ese creador', async () => {
      const response = await request(app.getHttpServer())
        .get(byEmail('Beto@Integration-E2E.test'))
        .set(api('org1-full'))
        .expect(200);

      expect(
        response.body.data.items.map((item: { id: string }) => item.id),
      ).toEqual([ids['doc:beto-1']]);
    });

    it('con sólo OWN admite su propio correo', async () => {
      await activateOnly('org1-own');
      const response = await request(app.getHttpServer())
        .get(byEmail('ana@integration-e2e.test'))
        .set(api('org1-own'))
        .expect(200);
      expect(response.body.data.pagination.total).toBe(2);
    });

    it('con sólo OWN no puede pedir a otro creador', async () => {
      await activateOnly('org1-own');
      const response = await request(app.getHttpServer())
        .get(byEmail('beto@integration-e2e.test'))
        .set(api('org1-own'))
        .expect(403);
      expect(response.body.error.code).toBe('INTEGRATION_SCOPE_DENIED');
    });

    it.each([
      ['de otra organización', 'carla@integration-e2e.test'],
      ['que no existe', 'nadie@integration-e2e.test'],
    ])('404 a un correo %s', async (_label, email) => {
      const response = await request(app.getHttpServer())
        .get(byEmail(email))
        .set(api('org1-full'))
        .expect(404);
      expect(response.body.error.code).toBe('INTEGRATION_USER_NOT_FOUND');
    });
  });

  describe('POST /integration/documents/:documentId/collaborators/:collaboratorId/resend-invitation', () => {
    const resendUrl = (documentKey: string, collaboratorId: string) =>
      `/api/v1/integration/documents/${ids[`doc:${documentKey}`] ?? documentKey}/collaborators/${collaboratorId}/resend-invitation`;
    const signers: Record<string, string> = {};

    beforeAll(async () => {
      for (const [key, documentKey, order] of [
        ['beto-fiel', 'beto-1', 1],
        ['beto-fiel-2', 'beto-1', 2],
        ['carla-fiel', 'carla-1', 1],
      ] as const) {
        const [collaborator] = await dataSource.query(
          `INSERT INTO collaborators (document_id, email, colaborator_type, signature_type, status, signing_order, ip_address)
           VALUES ($1, $2, 'SIGNER', 'FIEL', 'PENDING', $3, '127.0.0.1') RETURNING id`,
          [ids[`doc:${documentKey}`], `${key}@externo.test`, order],
        );
        signers[key] = collaborator.id;
      }
      await dataSource.query(
        `UPDATE documents SET is_sequential = true WHERE id = $1`,
        [ids['doc:beto-1']],
      );
    });

    afterAll(async () => {
      await dataSource.query(`DELETE FROM collaborators WHERE id = ANY($1)`, [
        Object.values(signers),
      ]);
    });

    beforeEach(() => {
      delivered.length = 0;
    });

    it('reenvía al firmante en turno, con la llave de la petición en la auditoría', async () => {
      const response = await request(app.getHttpServer())
        .post(resendUrl('beto-1', signers['beto-fiel']))
        .set(api('org1-full'))
        .expect(200);

      expect(response.body.data).toEqual({
        collaboratorId: signers['beto-fiel'],
        invitationExpiresAt: '2026-12-01T00:00:00.000Z',
        emailDelivered: true,
      });
      expect(delivered).toEqual([
        {
          documentId: ids['doc:beto-1'],
          collaboratorId: signers['beto-fiel'],
          apiKeyId: ids['key:org1-full'],
        },
      ]);
    });

    it('409 a un firmante que todavía no está en turno', async () => {
      const response = await request(app.getHttpServer())
        .post(resendUrl('beto-1', signers['beto-fiel-2']))
        .set(api('org1-full'))
        .expect(409);
      expect(response.body.error.code).toBe(
        'INTEGRATION_INVITATION_NOT_RESENDABLE',
      );
      expect(delivered).toEqual([]);
    });

    it.each([
      [
        'un documento de otra organización',
        () => resendUrl('carla-1', signers['carla-fiel']),
      ],
      [
        'un colaborador que no es de ese documento',
        () => resendUrl('beto-1', signers['carla-fiel']),
      ],
      ['ids que no son UUID', () => resendUrl('no-es-uuid', 'tampoco')],
    ])('404 a %s, sin revelar nada', async (_label, url) => {
      const response = await request(app.getHttpServer())
        .post(url())
        .set(api('org1-full'))
        .expect(404);
      expect(response.body.error.code).toBe('INTEGRATION_SIGNER_NOT_FOUND');
      expect(delivered).toEqual([]);
    });

    it('403 a una llave sin DOCUMENT.CREATE', async () => {
      await activateOnly('org1-own');
      const response = await request(app.getHttpServer())
        .post(resendUrl('beto-1', signers['beto-fiel']))
        .set(api('org1-own'))
        .expect(403);
      expect(response.body.error.code).toBe('API_KEY_PERMISSION_DENIED');
    });
  });

  describe('POST /integration/documents', () => {
    describe('creador', () => {
      it('un correo nuevo se aprovisiona: usuario PROVISIONED, cuenta personal y membresía mínima', async () => {
        const email = `nuevo-${randomUUID()}@cliente.test`;
        const joinedBefore = membersJoined;

        const response = await postDocument(
          'org1-full',
          `nuevo-${randomUUID()}`,
          {
            body: payload((value) => {
              value.creator = {
                email: email.toUpperCase(),
                firstName: 'nora',
                lastName: 'nueva',
              };
            }),
          },
        ).expect(201);

        const user = await userByEmail(email);
        expect(user).toMatchObject({
          first_name: 'Nora',
          lifecycle_status: 'PROVISIONED',
          password: null,
          national_id: null,
          personal_information_id: null,
        });
        const accounts = await accountsOf(user.id);
        expect(accounts).toEqual([
          expect.objectContaining({
            account_type: 'PERSONAL',
            organization_id: null,
            password: null,
            role: 'OWNER',
          }),
          expect.objectContaining({
            account_type: 'ORGANIZATION',
            organization_id: ids['org:org1'],
            is_active: true,
            password: null,
            role: 'INTEGRATION_DOCUMENT_CREATOR',
          }),
        ]);
        expect(membersJoined - joinedBefore).toBe(1);

        const [document] = await dataSource.query(
          `SELECT created_by, account_id, organization_id, created_via_api_key_id FROM documents WHERE id = $1`,
          [response.body.data.id],
        );
        expect(document).toEqual({
          created_by: user.id,
          account_id: accounts[1].id,
          organization_id: ids['org:org1'],
          created_via_api_key_id: ids['key:org1-full'],
        });
      });

      it('responde con estatus, datos básicos y la URL pública armada con PUBLIC_WEB_APP_URL', async () => {
        const response = await postDocument(
          'org1-full',
          `respuesta-${randomUUID()}`,
        )
          .set('Host', 'atacante.example')
          .expect(201);

        expect(response.headers['idempotent-replayed']).toBe('false');
        expect(response.body).toEqual({
          success: true,
          message: expect.any(String),
          data: {
            id: expect.any(String),
            status: 'PENDING_SIGNATURE',
            signatureType: 'SIMPLE',
            fileName: 'contrato-erp.pdf',
            createdAt: expect.any(String),
            creator: { email: 'ana@integration-e2e.test' },
            participantsCount: 2,
            publicUrl: `https://app.firmalo.test/public/documents/${response.body.data.id}`,
            // Firmantes en orden, sin URLs de firma (el doble del flujo no guarda su tipo).
            participants: [
              {
                email: 'luis@correo.test',
                status: 'PENDING',
                signatureType: null,
                order: 1,
              },
            ],
          },
        });
      });

      it('un miembro activo usa su propia cuenta, sin tocar sus datos aunque el payload traiga otro nombre', async () => {
        const response = await postDocument(
          'org1-full',
          `miembro-${randomUUID()}`,
          {
            body: payload((value) => {
              value.creator = {
                email: '  ANA@integration-e2e.test ',
                firstName: 'Otro',
                lastName: 'Nombre',
              };
            }),
          },
        ).expect(201);

        const [document] = await dataSource.query(
          `SELECT created_by, account_id FROM documents WHERE id = $1`,
          [response.body.data.id],
        );
        expect(document).toEqual({
          created_by: ids['user:ana'],
          account_id: ids['account:ana'],
        });
        expect((await userByEmail('ana@integration-e2e.test')).first_name).toBe(
          'ana',
        );
      });

      it('un usuario existente sin membresía recibe una, sin otra cuenta personal ni cambios en sus datos', async () => {
        // carla existe (es de org2); la llave es de org1.
        const before = await accountsOf(ids['user:carla']);

        const response = await postDocument(
          'org1-full',
          `sin-membresia-${randomUUID()}`,
          {
            body: payload((value) => {
              value.creator = {
                email: 'carla@integration-e2e.test',
                firstName: 'Cambiada',
                lastName: 'X',
              };
            }),
          },
        ).expect(201);

        const after = await accountsOf(ids['user:carla']);
        expect(after).toHaveLength(before.length + 1);
        const created = after.find(
          (account: { organization_id: string }) =>
            account.organization_id === ids['org:org1'],
        );
        expect(created.role).toBe('INTEGRATION_DOCUMENT_CREATOR');
        expect(
          (await userByEmail('carla@integration-e2e.test')).first_name,
        ).toBe('carla');

        const [document] = await dataSource.query(
          `SELECT created_by, account_id FROM documents WHERE id = $1`,
          [response.body.data.id],
        );
        expect(document).toEqual({
          created_by: ids['user:carla'],
          account_id: created.id,
        });
      });

      it('no readmite a un creador dado de baja de la organización', async () => {
        const response = await postDocument(
          'org1-full',
          `baja-${randomUUID()}`,
          {
            body: payload((value) => {
              value.creator.email = 'dario@integration-e2e.test';
            }),
          },
        ).expect(422);

        expect(response.body.error.code).toBe(
          'INTEGRATION_CREATOR_MEMBERSHIP_REVOKED',
        );
        const [{ count }] = await dataSource.query(
          `SELECT count(*)::int AS count FROM accounts WHERE user_id = $1 AND organization_id = $2 AND is_active`,
          [ids['user:dario'], ids['org:org1']],
        );
        expect(count).toBe(0);
      });

      it('dos altas simultáneas con el mismo creador nuevo crean un solo usuario y una sola membresía', async () => {
        const email = `simultaneo-${randomUUID()}@cliente.test`;

        const responses = await Promise.all(
          Array.from({ length: 4 }, () =>
            postDocument('org1-full', `simultaneo-${randomUUID()}`, {
              body: payload((value) => {
                value.creator.email = email;
              }),
            }),
          ),
        );

        expect(responses.map((response) => response.status)).toEqual([
          201, 201, 201, 201,
        ]);
        const user = await userByEmail(email);
        expect(await accountsOf(user.id)).toHaveLength(2);
      });
    });

    describe('idempotencia', () => {
      it('un reintento con la misma clave y contenido devuelve el mismo documento sin crear ni cobrar', async () => {
        const idempotencyKey = `reintento-${randomUUID()}`;
        const email = `reintento-${randomUUID()}@cliente.test`;
        const body = payload((value) => {
          value.creator.email = email;
        });
        const charged = creditsCharged;

        const first = await postDocument('org1-full', idempotencyKey, {
          body,
        }).expect(201);
        const retry = await postDocument('org1-full', idempotencyKey, {
          body,
        }).expect(200);

        expect(retry.headers['idempotent-replayed']).toBe('true');
        expect(retry.body.data).toEqual(first.body.data);
        expect(creditsCharged - charged).toBe(1);
        const [{ count }] = await dataSource.query(
          `SELECT count(*)::int AS count FROM documents WHERE created_by = $1`,
          [(await userByEmail(email)).id],
        );
        expect(count).toBe(1);
      });

      it('la misma clave con otro payload responde 409', async () => {
        const idempotencyKey = `otro-payload-${randomUUID()}`;
        await postDocument('org1-full', idempotencyKey).expect(201);

        const response = await postDocument('org1-full', idempotencyKey, {
          body: payload((value) => {
            value.document.signatureType = 'ADVANCED';
          }),
        }).expect(409);

        expect(response.body.error.code).toBe(
          'INTEGRATION_IDEMPOTENCY_KEY_MISMATCH',
        );
      });

      it('la misma clave con otro archivo responde 409', async () => {
        const idempotencyKey = `otro-archivo-${randomUUID()}`;
        await postDocument('org1-full', idempotencyKey).expect(201);

        const response = await postDocument('org1-full', idempotencyKey, {
          pdf: otherPdf,
        }).expect(409);

        expect(response.body.error.code).toBe(
          'INTEGRATION_IDEMPOTENCY_KEY_MISMATCH',
        );
      });

      it('peticiones simultáneas con la misma clave crean un solo documento y cobran una vez', async () => {
        const idempotencyKey = `simultaneas-${randomUUID()}`;
        const charged = creditsCharged;

        const responses = await Promise.all(
          Array.from({ length: 5 }, () =>
            postDocument('org1-full', idempotencyKey),
          ),
        );

        const statuses = responses.map((response) => response.status);
        expect(statuses.filter((status) => status === 201)).toHaveLength(1);
        // Las demás: repetición (200) o "en curso" (409), nunca otro documento.
        for (const response of responses.filter((r) => r.status !== 201)) {
          expect([200, 409]).toContain(response.status);
          if (response.status === 409) {
            expect(response.body.error.code).toBe(
              'INTEGRATION_IDEMPOTENCY_KEY_IN_PROGRESS',
            );
          }
        }
        expect(creditsCharged - charged).toBe(1);
        const [{ count }] = await dataSource.query(
          `SELECT count(*)::int AS count FROM integration_idempotency_keys WHERE idempotency_key = $1`,
          [idempotencyKey],
        );
        expect(count).toBe(1);
      });

      it('si el alta falla, libera la clave y el reintento crea el documento', async () => {
        const idempotencyKey = `fallo-${randomUUID()}`;
        flowFailures = 1;

        await postDocument('org1-full', idempotencyKey).expect(500);
        const [{ count }] = await dataSource.query(
          `SELECT count(*)::int AS count FROM integration_idempotency_keys WHERE idempotency_key = $1`,
          [idempotencyKey],
        );
        expect(count).toBe(0);

        await postDocument('org1-full', idempotencyKey).expect(201);
      });

      it('la unicidad es por llave: la misma clave con otra llave es otra clave', async () => {
        const idempotencyKey = `compartida-${randomUUID()}`;

        const org1 = await postDocument('org1-full', idempotencyKey).expect(
          201,
        );
        const org2 = await postDocument('org2-full', idempotencyKey, {
          body: payload((value) => {
            value.creator.email = 'carla@integration-e2e.test';
          }),
        }).expect(201);

        expect(org2.body.data.id).not.toBe(org1.body.data.id);
      });

      it('una clave vencida se libera y vuelve a crear', async () => {
        const idempotencyKey = `vencida-${randomUUID()}`;
        const first = await postDocument('org1-full', idempotencyKey).expect(
          201,
        );
        await dataSource.query(
          `UPDATE integration_idempotency_keys SET expires_at = now() - interval '1 minute' WHERE idempotency_key = $1`,
          [idempotencyKey],
        );

        const again = await postDocument('org1-full', idempotencyKey).expect(
          201,
        );

        expect(again.body.data.id).not.toBe(first.body.data.id);
      });
    });

    describe('validación del contrato', () => {
      it('exige Idempotency-Key', async () => {
        const response = await postDocument('org1-full', null).expect(400);
        expect(response.body.error.code).toBe(
          'INTEGRATION_IDEMPOTENCY_KEY_REQUIRED',
        );
      });

      it('exige el archivo PDF', async () => {
        await request(app.getHttpServer())
          .post('/api/v1/integration/documents')
          .set(api('org1-full'))
          .set('Idempotency-Key', `sin-archivo-${randomUUID()}`)
          .field('payload', JSON.stringify(payload()))
          .expect(400);
      });

      describe('colaboradores y posiciones (422 con código y campo)', () => {
        const signer = (email: string, order: number, extra: object = {}) => ({
          role: 'SIGNER',
          firstName: 'Firma',
          lastName: 'Prueba',
          email,
          order,
          signaturePositions: [{ ...POSITION, yRatio: 0.1 * order }],
          ...extra,
        });

        it.each([
          [
            'un payload que no es JSON',
            '{no es json',
            'INVALID_PAYLOAD',
            'payload',
          ],
          [
            'sin creador',
            (v: any) => delete v.creator,
            'INVALID_CREATOR',
            'creator',
          ],
          [
            'un correo de creador inválido',
            (v: any) => (v.creator.email = 'no-es-correo'),
            'INVALID_CREATOR',
            'creator.email',
          ],
          [
            'sin participants',
            (v: any) => delete v.participants,
            'PARTICIPANTS_REQUIRED',
            'participants',
          ],
          [
            'participants vacío',
            (v: any) => (v.participants = []),
            'PARTICIPANTS_REQUIRED',
            'participants',
          ],
          [
            'sin ningún SIGNER',
            (v: any) => (v.participants = [v.participants[1]]),
            'SIGNER_REQUIRED',
            'participants',
          ],
          [
            'un rol desconocido',
            (v: any) => (v.participants[1].role = 'VIEWER'),
            'INVALID_PARTICIPANT_ROLE',
            'participants[1].role',
          ],
          [
            'un nombre vacío',
            (v: any) => (v.participants[0].firstName = ' '),
            'INVALID_PARTICIPANT_NAME',
            'participants[0].firstName',
          ],
          [
            'un apellido demasiado largo',
            (v: any) => (v.participants[0].lastName = 'x'.repeat(101)),
            'INVALID_PARTICIPANT_NAME',
            'participants[0].lastName',
          ],
          [
            'un correo de colaborador inválido',
            (v: any) => (v.participants[0].email = 'luis@'),
            'INVALID_PARTICIPANT_EMAIL',
            'participants[0].email',
          ],
          [
            'un correo repetido con otro rol y mayúsculas',
            (v: any) => (v.participants[1].email = ' LUIS@correo.test'),
            'DUPLICATE_PARTICIPANT_EMAIL',
            'participants[1].email',
          ],
          [
            'un firmante sin posiciones',
            (v: any) => delete v.participants[0].signaturePositions,
            'SIGNER_SIGNATURE_POSITION_REQUIRED',
            'participants[0].signaturePositions',
          ],
          [
            'un testigo con posiciones',
            (v: any) =>
              (v.participants[1].signaturePositions = [
                { ...POSITION, yRatio: 0.5 },
              ]),
            'WITNESS_SIGNATURE_POSITION_NOT_ALLOWED',
            'participants[1].signaturePositions',
          ],
          [
            'un firmante sin order en documento secuencial',
            (v: any) => delete v.participants[0].order,
            'INVALID_SIGNING_ORDER',
            'participants[0].order',
          ],
          [
            'órdenes repetidos',
            (v: any) =>
              (v.participants = [
                signer('a@correo.test', 1),
                signer('b@correo.test', 1, {
                  signaturePositions: [{ ...POSITION, yRatio: 0.5 }],
                }),
              ]),
            'DUPLICATE_SIGNING_ORDER',
            'participants[1].order',
          ],
          [
            'órdenes no consecutivos',
            (v: any) =>
              (v.participants = [
                signer('a@correo.test', 1),
                signer('b@correo.test', 3),
              ]),
            'INVALID_SIGNING_ORDER',
            'participants',
          ],
          [
            'una posición con página 0',
            (v: any) => (v.participants[0].signaturePositions[0].page = 0),
            'INVALID_SIGNATURE_POSITION',
            'participants[0].signaturePositions[0].page',
          ],
          [
            'un ratio fuera de rango',
            (v: any) => (v.participants[0].signaturePositions[0].xRatio = 2),
            'INVALID_SIGNATURE_POSITION',
            'participants[0].signaturePositions[0].xRatio',
          ],
          [
            'un ancho de 0',
            (v: any) =>
              (v.participants[0].signaturePositions[0].widthRatio = 0),
            'INVALID_SIGNATURE_POSITION',
            'participants[0].signaturePositions[0].widthRatio',
          ],
          [
            'una página que el PDF no tiene',
            (v: any) => (v.participants[0].signaturePositions[0].page = 3),
            'SIGNATURE_POSITION_PAGE_OUT_OF_RANGE',
            'participants[0].signaturePositions[0].page',
          ],
          [
            'una caja que se sale de la página',
            (v: any) =>
              Object.assign(v.participants[0].signaturePositions[0], {
                xRatio: 0.95,
                widthRatio: 0.2,
              }),
            'INVALID_SIGNATURE_POSITION',
            'participants[0].signaturePositions[0]',
          ],
          [
            'posiciones traslapadas entre firmantes',
            (v: any) =>
              (v.participants = [
                signer('a@correo.test', 1),
                signer('b@correo.test', 2, {
                  signaturePositions: [
                    { ...POSITION, yRatio: 0.1, xRatio: 0.15 },
                  ],
                }),
              ]),
            'SIGNATURE_POSITION_OVERLAP',
            'participants[1].signaturePositions[0]',
          ],
        ])('rechaza %s', async (_label, patch, code, field) => {
          const before = creditsCharged;

          const response = await postDocument(
            'org1-full',
            `regla-${randomUUID()}`,
            {
              body:
                typeof patch === 'string'
                  ? patch
                  : payload(patch as (v: any) => void),
            },
          ).expect(422);

          expect(response.body).toEqual({
            success: false,
            error: {
              code,
              message: expect.any(String),
              details: expect.objectContaining({ field }),
            },
          });
          expect(creditsCharged).toBe(before);
        });

        it('rechaza más colaboradores que el máximo, con el límite y lo recibido', async () => {
          const participants = [
            signer('firmante@correo.test', 1),
            ...Array.from({ length: 52 }, (_, index) => ({
              role: 'WITNESS',
              firstName: 'Testigo',
              lastName: `${index}`,
              email: `testigo-${index}@correo.test`,
            })),
          ];

          const response = await postDocument(
            'org1-full',
            `maximo-${randomUUID()}`,
            {
              body: payload((value) => (value.participants = participants)),
            },
          ).expect(422);

          expect(response.body).toEqual({
            success: false,
            error: {
              code: 'MAX_PARTICIPANTS_EXCEEDED',
              message: 'El documento admite como máximo 50 colaboradores.',
              details: { field: 'participants', limit: 50, received: 53 },
            },
          });
        });

        it('un error de validación no ocupa la Idempotency-Key ni aprovisiona al creador', async () => {
          const idempotencyKey = `invalido-luego-valido-${randomUUID()}`;
          const email = `sin-alta-${randomUUID()}@cliente.test`;

          await postDocument('org1-full', idempotencyKey, {
            body: payload((value) => {
              value.creator.email = email;
              value.participants[0].signaturePositions[0].page = 9;
            }),
          }).expect(422);
          expect(await userByEmail(email)).toBeUndefined();

          await postDocument('org1-full', idempotencyKey, {
            body: payload((value) => (value.creator.email = email)),
          }).expect(201);
        });

        it('un archivo que no es PDF responde INVALID_DOCUMENT_FILE', async () => {
          const response = await postDocument(
            'org1-full',
            `no-pdf-${randomUUID()}`,
            {
              pdf: 'esto no es un pdf',
            },
          ).expect(422);

          expect(response.body.error).toMatchObject({
            code: 'INVALID_DOCUMENT_FILE',
            details: { field: 'file' },
          });
        });

        it('un documento no secuencial puede omitir order', async () => {
          await postDocument('org1-full', `no-secuencial-${randomUUID()}`, {
            body: payload((value) => {
              value.document.isSequential = false;
              delete value.participants[0].order;
              delete value.participants[1].order;
            }),
          }).expect(201);
        });
      });

      it('un error inesperado responde 500 genérico, sin detalles internos', async () => {
        flowFailures = 1;

        const response = await postDocument(
          'org1-full',
          `interno-${randomUUID()}`,
        ).expect(500);

        expect(response.body).toEqual({
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Ocurrió un error interno. Vuelve a intentarlo más tarde.',
          },
        });
      });

      it.each([
        [
          'organizationId',
          (value: Record<string, any>) => (value.organizationId = 'ORG2'),
        ],
        [
          'taxId',
          (value: Record<string, any>) => (value.document.taxId = 'RFC'),
        ],
        [
          'userId',
          (value: Record<string, any>) => (value.creator.userId = 'USER'),
        ],
        [
          'accountId',
          (value: Record<string, any>) => (value.creator.accountId = 'ACC'),
        ],
        [
          'createdBy',
          (value: Record<string, any>) => (value.document.createdBy = 'USER'),
        ],
        [
          'permissionIds',
          (value: Record<string, any>) => (value.permissionIds = []),
        ],
        [
          'documentBase64',
          (value: Record<string, any>) => (value.documentBase64 = 'JVBERi0'),
        ],
      ])(
        'rechaza %s en el payload sin crear ni aprovisionar nada',
        async (field, patch) => {
          const email = `prohibido-${field}-${randomUUID()}@cliente.test`;

          const response = await postDocument(
            'org1-full',
            `prohibido-${randomUUID()}`,
            {
              body: payload((value) => {
                value.creator.email = email;
                patch(value);
              }),
            },
          ).expect(400);

          expect(response.body.error.code).toBe(
            'INTEGRATION_TENANT_OVERRIDE_NOT_ALLOWED',
          );
          expect(await userByEmail(email)).toBeUndefined();
        },
      );

      it('rechaza requiresApproval: true', async () => {
        const response = await postDocument(
          'org1-full',
          `aprobacion-${randomUUID()}`,
          {
            body: payload((value) => (value.document.requiresApproval = true)),
          },
        ).expect(400);
        expect(response.body.error.code).toBe(
          'INTEGRATION_APPROVAL_NOT_SUPPORTED',
        );
      });

      it('responde 403 a una llave sin DOCUMENT.CREATE', async () => {
        await activateOnly('org1-own');

        const response = await postDocument(
          'org1-own',
          `sin-permiso-${randomUUID()}`,
        ).expect(403);
        expect(response.body.error.code).toBe('API_KEY_PERMISSION_DENIED');
      });
    });
  });

  describe('documentación Swagger', () => {
    it.each([
      [
        '/api/v1/integration/documents',
        'get',
        ['200', '400', '401', '403', '404', '422'],
      ],
      [
        '/api/v1/integration/documents/{documentId}/collaborators/{collaboratorId}/resend-invitation',
        'post',
        ['200', '400', '401', '403', '404', '409', '429'],
      ],
      [
        '/api/v1/integration/users/{userId}/documents',
        'get',
        ['200', '400', '401', '403', '404', '422'],
      ],
      [
        '/api/v1/integration/documents',
        'post',
        ['200', '201', '400', '401', '402', '403', '409', '422'],
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
        // La llave se documenta una vez, en el esquema de seguridad; no como parámetro.
        expect(
          operation.parameters?.map((parameter) => parameter.name) ?? [],
        ).not.toContain('X-API-Key');
        expect(
          swagger.components?.securitySchemes?.[INTEGRATION_API_KEY_SECURITY],
        ).toEqual(expect.objectContaining({ in: 'header', name: 'X-API-Key' }));
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

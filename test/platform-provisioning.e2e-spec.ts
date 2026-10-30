import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { join } from 'path';
import { PDFDocument } from 'pdf-lib';
import { Client } from 'pg';
import * as request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AccountMemberService } from './../src/account/account-member.service';
import { AccountService } from './../src/account/account.service';
import { AccountEntity } from './../src/account/entities/account.entity';
import { OrganizationEntity } from './../src/account/entities/organization.entity';
import { ApiKeyModule } from './../src/api-key/api-key.module';
import { IssuePlatformApiKeyUseCase } from './../src/api-key/applications/issue-platform-api-key.use-case';
import { ApiKeyGuard } from './../src/auth/guards/api-key.guard';
import { JwtAuthGuard } from './../src/auth/guards/jwt-auth.guard';
import { AuthorizationModule } from './../src/authorization/authorization.module';
import { CheckoutOrderEntity } from './../src/billing/checkout/checkout-order.entity';
import { CheckoutOrderService } from './../src/billing/checkout/checkout-order.service';
import { CreditLotEntity } from './../src/billing/credits/credit-lot.entity';
import { DocumentCreditConsumptionEntity } from './../src/billing/credits/document-credit-consumption.entity';
import { SubscriptionBillingHistoryEntity } from './../src/billing/subscriptions/subscription-billing-history.entity';
import { ConsumeDocumentCreditUseCase } from './../src/billing/credits/consume-document-credit.use-case';
import { BillingEntitlementsModule } from './../src/billing/entitlements/billing-entitlements.module';
import { GetBillingAccessUseCase } from './../src/billing/entitlements/get-billing-access.use-case';
import { BillingProfileProvisioningService } from './../src/billing/profiles/billing-profile-provisioning.service';
import { RegisterManualSubscriptionBillingUseCase } from './../src/billing/subscriptions/register-manual-subscription-billing.use-case';
import { RegisterSubscriptionBillingUseCase } from './../src/billing/subscriptions/register-subscription-billing.use-case';
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
import { IssueIntegrationSigningAccessUseCase } from './../src/document/integration/applications/issue-integration-signing-access.use-case';
import { ListOrganizationIntegrationDocumentsUseCase } from './../src/document/integration/applications/list-organization-integration-documents.use-case';
import { ListUserIntegrationDocumentsUseCase } from './../src/document/integration/applications/list-user-integration-documents.use-case';
import { ResendIntegrationSigningInvitationUseCase } from './../src/document/integration/applications/resend-integration-signing-invitation.use-case';
import { IntegrationIdempotencyKeyEntity } from './../src/document/integration/entities/integration-idempotency-key.entity';
import { IntegrationDocumentsController } from './../src/document/integration/integration-documents.controller';
import { IntegrationCreatorService } from './../src/document/integration/services/integration-creator.service';
import { IntegrationIdempotencyService } from './../src/document/integration/services/integration-idempotency.service';
import { IntegrationPayloadValidator } from './../src/document/integration/validation/integration-payload.validator';
import { DocumentReadService } from './../src/document/services/document-read.service';
import { OrganizationMemberEventsProducer } from './../src/kafka/organization-member.producer';
import { DEFAULT_INTEGRATION_PERMISSION_KEYS } from '../src/platform/constants/default-integration-permissions';
import { ProvisionProvisionalEnterpriseAccountUseCase } from '../src/platform/applications/provision-provisional-enterprise-account.use-case';
import { PlatformRequestEntity } from '../src/platform/entities/platform-request.entity';
import { InternalOrganizationProvisioningController } from '../src/platform/internal-organization-provisioning.controller';
import { ProvisionalOwnerProvisioningService } from '../src/platform/services/provisional-owner-provisioning.service';
import { RolesModule } from './../src/roles/roles.module';
import { SigningInvitationDeliveryService } from './../src/signing-invitation/signing-invitation-delivery.service';
import { UserEntity } from './../src/user/entities/user.entity';
import { UserService } from './../src/user/user.service';

config({ path: join(__dirname, '..', '.env') });

const INTEGRATION_API_KEY_HMAC_SECRET =
  'pepper-de-la-e2e-de-aprovisionamiento-con-32-caracteres';
const INTERNAL_KEY = 'llave-interna-de-plataforma-e2e-con-mas-de-32-caracteres';
const SHARED_SERVICES_KEY =
  'llave-compartida-de-servicios-e2e-con-32-caracteres';

/** Redis no existe aquí: el catálogo de cuentas y el blacklist de JWT son best-effort o vacíos. */
const redisStub = {
  exists: async () => false,
  get: async () => null,
  set: async () => undefined,
};

/**
 * Los guards globales reales, en el orden de `AppModule`: `ApiKeyGuard` (compara `API_KEY` en las
 * rutas `@Public()`) y `JwtAuthGuard`. Así se comprueba que el aprovisionamiento NO acepta la llave
 * compartida de servicios ni depende de un JWT.
 */
@Module({
  imports: [JwtModule.register({ secret: 'jwt-secret-e2e-aprovisionamiento' })],
  providers: [
    { provide: RedisService, useValue: redisStub },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [RedisService],
})
class E2eGlobalGuardsModule {}

async function buildPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save());
}

/**
 * Aprovisionamiento interno de punta a punta, contra Postgres de verdad: guard interno, la
 * transacción con usuario, organización, OWNER, perfil manual, periodo, créditos y llave, la
 * idempotencia con su bloqueo asesor, y la llave usada en la API de integración real
 * (`OrganizationApiKeyGuard` + `ApiKeyPermissionGuard`) cobrando un crédito con
 * `ConsumeDocumentCreditUseCase` real.
 *
 * Lo único reemplazado: Redis, Kafka, el correo y el alta física del documento (MinIO, PDF sellado),
 * que el doble del flujo hace como el real —gancho del origen y cobro dentro de la transacción—.
 *
 * **No toca `signature_db`.** Crea `signature_provisioning_e2e_*`, le aplica todas las migraciones y
 * la borra al terminar.
 */
describe('Aprovisionamiento interno de cuentas Enterprise (e2e)', () => {
  const DATABASE_NAME = `signature_provisioning_e2e_${process.pid}_${Date.now()}`;
  const baseUrl = process.env.POSTGRES_DB_URL as string;
  const adminUrl = baseUrl.replace(/\/[^/?]+(\?.*)?$/, '/postgres$1');
  const databaseUrl = baseUrl.replace(
    /\/[^/?]+(\?.*)?$/,
    `/${DATABASE_NAME}$1`,
  );

  let app: INestApplication;
  let dataSource: DataSource;
  let pdf: Buffer;
  let consumeCredit: ConsumeDocumentCreditUseCase;
  let billingAccess: GetBillingAccessUseCase;
  let issuePlatformApiKey: IssuePlatformApiKeyUseCase;

  async function adminQuery(sql: string): Promise<void> {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  /** Doble del flujo de alta: guarda el documento, llama al gancho y cobra con el use case real. */
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
          await consumeCredit.execute(
            { documentId: saved.id, accountId, userId: createdBy },
            manager,
          );
          return saved;
        },
      );
      return { success: true, message: 'ok', data: { id: document.id } };
    },
  };

  function body(patch: (value: Record<string, any>) => void = () => {}) {
    const value: Record<string, any> = {
      organization: {
        name: 'Acme Pruebas',
        organizationName: 'Acme Pruebas S.A. de C.V.',
        taxId: 'ACM010101AAA',
        domainAllowed: 'acme.test',
      },
      owner: { firstName: 'Ana', lastName: 'López', email: 'ana@acme.test' },
      billing: {
        documentsGranted: 1600,
        periodStart: '2026-11-01T00:00:00.000Z',
        periodEnd: '2027-11-01T00:00:00.000Z',
        externalReference: 'PROVISION-ACME-TEST-001',
      },
      apiKeyName: 'Integración Enterprise Acme',
    };
    patch(value);
    return value;
  }

  function provision(
    payload: Record<string, any>,
    idempotencyKey: string | null,
    apiKey: string | null = INTERNAL_KEY,
  ) {
    let call = request(app.getHttpServer())
      .post('/api/v1/platform/organizations/provision')
      .send(payload);
    if (apiKey) call = call.set('x-api-key', apiKey);
    if (idempotencyKey) call = call.set('Idempotency-Key', idempotencyKey);
    return call;
  }

  /** Crea recurso, acción y permiso de una clave `RECURSO.ACCION[_ALCANCE]` si faltan. */
  async function ensurePermission(key: string): Promise<void> {
    const [resource, rest] = key.split('.');
    const scoped = /^(.+)_(OWN|ORGANIZATION)$/.exec(rest);
    const [action, scope] = scoped ? [scoped[1], scoped[2]] : [rest, 'ANY'];
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
  }

  async function count(table: string): Promise<number> {
    const [row] = await dataSource.query(
      `SELECT count(*)::int AS n FROM ${table}`,
    );
    return row.n;
  }

  async function snapshotCounts() {
    return {
      users: await count('users'),
      organizations: await count('organizations'),
      accounts: await count('accounts'),
      billingProfiles: await count('billing_profiles'),
      creditLots: await count('credit_lots'),
      history: await count('subscription_billing_history'),
      apiKeys: await count('api_keys'),
      requests: await count('platform_provisioning_requests'),
    };
  }

  async function availableCredits(billingProfileId: string): Promise<number> {
    const [row] = await dataSource.query(
      `SELECT COALESCE(SUM(remaining), 0)::int AS n FROM credit_lots WHERE billing_profile_id = $1`,
      [billingProfileId],
    );
    return row.n;
  }

  beforeAll(async () => {
    process.env.INTEGRATION_API_KEY_HMAC_SECRET =
      INTEGRATION_API_KEY_HMAC_SECRET;
    process.env.INTERNAL_PLATFORM_API_KEY = INTERNAL_KEY;
    process.env.API_KEY = SHARED_SERVICES_KEY;
    process.env.PUBLIC_WEB_APP_URL = 'https://app.firmalo.test/';
    pdf = await buildPdf();
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
    // Como en la e2e de integración: el catálogo lo completa `npm run seed:roles`, no siempre las
    // migraciones, y el aprovisionamiento exige que estén los 8 permisos del perfil.
    for (const key of DEFAULT_INTEGRATION_PERMISSION_KEYS) {
      await ensurePermission(key);
    }

    @Module({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: databaseUrl,
          entities: [join(__dirname, '..', 'src', '**', '*.entity{.ts,.js}')],
        }),
        TypeOrmModule.forFeature([
          PlatformRequestEntity,
          DocumentEntity,
          CollaboratorEntity,
          AccountEntity,
          OrganizationEntity,
          UserEntity,
          IntegrationIdempotencyKeyEntity,
          CheckoutOrderEntity,
          CreditLotEntity,
          DocumentCreditConsumptionEntity,
          SubscriptionBillingHistoryEntity,
        ]),
        E2eGlobalGuardsModule,
        AuthorizationModule,
        ApiKeyModule,
        RolesModule,
        BillingEntitlementsModule,
      ],
      controllers: [
        InternalOrganizationProvisioningController,
        IntegrationDocumentsController,
      ],
      providers: [
        // Aprovisionamiento: todo real.
        ProvisionProvisionalEnterpriseAccountUseCase,
        ProvisionalOwnerProvisioningService,
        AccountService,
        AccountMemberService,
        BillingProfileProvisioningService,
        RegisterManualSubscriptionBillingUseCase,
        RegisterSubscriptionBillingUseCase,
        CheckoutOrderService,
        ConsumeDocumentCreditUseCase,
        {
          // Sólo los dos métodos del aprovisionamiento: el resto de `UserService` arrastra MinIO,
          // correo y firmas, que aquí no hacen falta.
          provide: UserService,
          inject: [AccountService],
          useFactory: (accountService: AccountService) =>
            Object.assign(Object.create(UserService.prototype), {
              accountService,
            }),
        },
        // API de integración: la de la e2e de integración.
        ListOrganizationIntegrationDocumentsUseCase,
        ListUserIntegrationDocumentsUseCase,
        CreateIntegrationDocumentUseCase,
        ResendIntegrationSigningInvitationUseCase,
        { provide: IssueIntegrationSigningAccessUseCase, useValue: {} },
        { provide: SigningInvitationDeliveryService, useValue: {} },
        DocumentReadService,
        IntegrationIdempotencyService,
        IntegrationCreatorService,
        IntegrationPayloadValidator,
        PdfSignatureService,
        {
          provide: OrganizationMemberEventsProducer,
          useValue: {
            enqueueJoined: async () => undefined,
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
    class ProvisioningE2eModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [ProvisioningE2eModule],
    }).compile();

    app = moduleRef.createNestApplication();
    applyGlobalApiPrefix(app);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    consumeCredit = moduleRef.get(ConsumeDocumentCreditUseCase);
    billingAccess = moduleRef.get(GetBillingAccessUseCase);
    issuePlatformApiKey = moduleRef.get(IssuePlatformApiKeyUseCase);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await dataSource?.destroy();
    await adminQuery(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
  });

  describe('seguridad', () => {
    it.each([
      ['sin x-api-key', null],
      ['con una llave equivocada', `${INTERNAL_KEY}-x`],
      ['con la llave compartida de servicios (API_KEY)', SHARED_SERVICES_KEY],
    ])('rechaza con 401 %s y no crea nada', async (_label, apiKey) => {
      const before = await snapshotCounts();

      await provision(body(), 'prov-seguridad', apiKey).expect(401);

      expect(await snapshotCounts()).toEqual(before);
    });

    it('rechaza con 400 un body que intenta elegir plan o permisos', async () => {
      const response = await provision(
        body((value) => {
          value.planType = 'plus';
          value.permissionIds = ['x'];
        }),
        'prov-reservados',
      ).expect(400);

      expect(response.body.code).toBe('RESERVED_FIELDS_NOT_ALLOWED');
    });

    it('exige Idempotency-Key', async () => {
      const response = await provision(body(), null).expect(400);
      expect(response.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('no aparece en el documento Swagger', () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      );
      expect(
        Object.keys(document.paths).filter((path) =>
          path.includes('platform/organizations'),
        ),
      ).toEqual([]);
    });
  });

  describe('éxito, idempotencia y uso de la llave', () => {
    let provisioned: Record<string, any>;

    it('aprovisiona la cuenta completa en una llamada', async () => {
      const response = await provision(body(), 'prov-acme-001').expect(201);
      provisioned = response.body.data;

      expect(response.headers['idempotent-replayed']).toBe('false');
      expect(provisioned).toEqual({
        organizationId: expect.any(String),
        organizationAccountId: expect.any(String),
        ownerUserId: expect.any(String),
        ownerAccountId: expect.any(String),
        ownerLifecycleStatus: 'PROVISIONED',
        ownerRole: 'OWNER',
        billingProfileId: expect.any(String),
        planType: 'enterprise',
        documentsGranted: 1600,
        creditsAvailable: 1600,
        apiKeyId: expect.any(String),
        apiKeyPrefix: expect.stringMatching(/^fma_live_[0-9a-f]{16}$/),
        apiKey: expect.stringMatching(
          /^fma_live_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/,
        ),
        replayed: false,
      });
      expect(provisioned.apiKey.startsWith(provisioned.apiKeyPrefix)).toBe(
        true,
      );

      const [user] = await dataSource.query(
        `SELECT lifecycle_status, password, national_id FROM users WHERE id = $1`,
        [provisioned.ownerUserId],
      );
      expect(user).toEqual({
        lifecycle_status: 'PROVISIONED',
        password: null,
        national_id: null,
      });

      const [membership] = await dataSource.query(
        `SELECT a.account_type, a.organization_id, a.is_active, r.name AS role, o.is_active AS org_active
         FROM accounts a JOIN roles r ON r.id = a.role_id JOIN organizations o ON o.id = a.organization_id
         WHERE a.id = $1`,
        [provisioned.organizationAccountId],
      );
      expect(membership).toEqual({
        account_type: 'ORGANIZATION',
        organization_id: provisioned.organizationId,
        is_active: true,
        role: 'OWNER',
        org_active: true,
      });

      const [profile] = await dataSource.query(
        `SELECT organization_id, current_plan_type, status, billing_source, stripe_customer_id, stripe_subscription_id
         FROM billing_profiles WHERE id = $1`,
        [provisioned.billingProfileId],
      );
      expect(profile).toEqual({
        organization_id: provisioned.organizationId,
        current_plan_type: 'enterprise',
        status: 'ACTIVE',
        billing_source: 'MANUAL',
        stripe_customer_id: null,
        stripe_subscription_id: null,
      });

      const [period] = await dataSource.query(
        `SELECT source, plan_type, amount, currency, external_reference, stripe_invoice_id
         FROM subscription_billing_history WHERE billing_profile_id = $1`,
        [provisioned.billingProfileId],
      );
      expect(period).toEqual({
        source: 'MANUAL',
        plan_type: 'enterprise',
        amount: 0,
        currency: 'mxn',
        external_reference: 'PROVISION-ACME-TEST-001',
        stripe_invoice_id: null,
      });
    });

    it('la llave no tiene emisor, ni su secreto en claro, y sólo lleva el perfil de integración', async () => {
      const [apiKey] = await dataSource.query(
        `SELECT * FROM api_keys WHERE id = $1`,
        [provisioned.apiKeyId],
      );
      expect(apiKey.created_by_account_id).toBeNull();
      expect(apiKey.status).toBe('ACTIVE');
      expect(JSON.stringify(apiKey)).not.toContain(
        provisioned.apiKey.split('_').pop(),
      );

      const permissions = await dataSource.query(
        `SELECT r.key || '.' || a.key || CASE WHEN p.scope = 'ANY' THEN '' ELSE '_' || p.scope END AS key
         FROM api_key_permissions akp JOIN permissions p ON p.id = akp.permission_id
         JOIN resources r ON r.id = p.resource_id JOIN actions a ON a.id = p.action_id
         WHERE akp.api_key_id = $1 ORDER BY 1`,
        [provisioned.apiKeyId],
      );
      expect(permissions.map((row: { key: string }) => row.key)).toEqual([
        'DIRECTORY.CREATE',
        'DIRECTORY.DELETE',
        'DIRECTORY.READ',
        'DIRECTORY.UPDATE',
        'DOCUMENT.CANCEL',
        'DOCUMENT.CREATE',
        'DOCUMENT.READ_ORGANIZATION',
        'DOCUMENT.SEND_SIGNATURE_REQUEST',
      ]);

      const [stored] = await dataSource.query(
        `SELECT * FROM platform_provisioning_requests WHERE idempotency_key = 'prov-acme-001'`,
      );
      expect(JSON.stringify(stored)).not.toContain(provisioned.apiKey);
    });

    it('la organización tiene API_INTEGRATION por el plan enterprise', async () => {
      const access = await billingAccess.execute({
        userId: provisioned.ownerUserId,
        accountId: provisioned.organizationAccountId,
      });
      expect(access.actions.apiIntegration).toBe(true);
    });

    it('repetir la clave no duplica nada y no vuelve a entregar la llave', async () => {
      const before = await snapshotCounts();

      const response = await provision(body(), 'prov-acme-001').expect(200);

      expect(response.headers['idempotent-replayed']).toBe('true');
      expect(response.body.data).toEqual({
        ...provisioned,
        apiKey: null,
        replayed: true,
      });
      expect(await snapshotCounts()).toEqual(before);
    });

    it('dos repeticiones simultáneas de una clave nueva crean una sola cuenta', async () => {
      const before = await snapshotCounts();
      const payload = body((value) => {
        value.owner.email = 'paralelo@acme.test';
        value.billing.externalReference = 'PROVISION-PARALELO-001';
      });

      const [first, second] = await Promise.all([
        provision(payload, 'prov-paralelo-001'),
        provision(payload, 'prov-paralelo-001'),
      ]);

      expect([first.status, second.status].sort()).toEqual([200, 201]);
      const after = await snapshotCounts();
      expect(after.organizations).toBe(before.organizations + 1);
      expect(after.apiKeys).toBe(before.apiKeys + 1);
      // Un solo periodo facturado. Los lotes suben dos: el del periodo y la bienvenida Free de la
      // cuenta personal del propietario nuevo, que nace como en el registro.
      expect(after.history).toBe(before.history + 1);
      expect(after.creditLots).toBe(before.creditLots + 2);
    });

    it('la misma clave con otros datos es 409', async () => {
      const response = await provision(
        body((value) => {
          value.billing.documentsGranted = 10;
        }),
        'prov-acme-001',
      ).expect(409);
      expect(response.body.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    });

    it('la llave crea un documento por POST /integration/documents y descuenta un crédito', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/integration/documents')
        .set('X-API-Key', provisioned.apiKey)
        .set('Idempotency-Key', 'doc-acme-001')
        .field(
          'payload',
          JSON.stringify({
            creator: {
              email: 'ana@acme.test',
              firstName: 'Ana',
              lastName: 'López',
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
                signaturePositions: [
                  {
                    page: 1,
                    xRatio: 0.1,
                    yRatio: 0.1,
                    widthRatio: 0.2,
                    heightRatio: 0.08,
                  },
                ],
              },
            ],
          }),
        )
        .attach('file', pdf, {
          filename: 'contrato.pdf',
          contentType: 'application/pdf',
        });

      expect(response.status).toBe(201);
      const [document] = await dataSource.query(
        `SELECT organization_id, created_by, created_via_api_key_id FROM documents WHERE id = $1`,
        [response.body.data.id],
      );
      expect(document).toEqual({
        organization_id: provisioned.organizationId,
        // El creador del payload es el propietario: usa su membresía OWNER, no crea otra.
        created_by: provisioned.ownerUserId,
        created_via_api_key_id: provisioned.apiKeyId,
      });
      expect(await availableCredits(provisioned.billingProfileId)).toBe(1599);
    });

    it('la llave no tiene permisos administrativos', async () => {
      await expect(
        issuePlatformApiKey.resolvePermissionProfile(['MEMBER.INVITE']),
      ).rejects.toMatchObject({ status: 422 });

      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM api_key_permissions akp JOIN permissions p ON p.id = akp.permission_id
         JOIN resources r ON r.id = p.resource_id
         WHERE akp.api_key_id = $1 AND r.key IN ('ORGANIZATION','MEMBER','ROLE','BILLING','USER','API_KEY')`,
        [provisioned.apiKeyId],
      );
      expect(n).toBe(0);
    });
  });

  describe('duplicados y rollback', () => {
    it('rechaza con 409 un folio ya usado por otra cuenta, sin crear nada', async () => {
      const before = await snapshotCounts();

      const response = await provision(
        body((value) => {
          value.owner.email = 'otra@acme.test';
        }),
        'prov-folio-repetido',
      ).expect(409);

      expect(response.body.code).toBe('EXTERNAL_REFERENCE_ALREADY_USED');
      expect(await snapshotCounts()).toEqual(before);
    });

    it('rechaza con 409 el correo de un usuario registrado (ACTIVE), sin crear nada', async () => {
      const [info] = await dataSource.query(
        `INSERT INTO personal_information (name, last_name, curp) VALUES ('Beto', 'E2E', 'CURPBETOE2E0000000') RETURNING id`,
      );
      await dataSource.query(
        `INSERT INTO users (first_name, last_name, email, roles, national_id, password, personal_information_id)
         VALUES ('Beto', 'E2E', 'beto@acme.test', 'user', 'NIDBETO', 'x', $1)`,
        [info.id],
      );
      const before = await snapshotCounts();

      const response = await provision(
        body((value) => {
          value.owner.email = 'beto@acme.test';
          value.billing.externalReference = 'PROVISION-BETO-001';
        }),
        'prov-beto',
      ).expect(409);

      expect(response.body.code).toBe('OWNER_EMAIL_ALREADY_REGISTERED');
      expect(await snapshotCounts()).toEqual(before);
    });

    it('reutiliza a un propietario PROVISIONED para una segunda organización', async () => {
      const response = await provision(
        body((value) => {
          value.organization.name = 'Acme Segunda';
          value.billing.externalReference = 'PROVISION-ACME-TEST-002';
        }),
        'prov-acme-002',
      ).expect(201);

      const [first] = await dataSource.query(
        `SELECT owner_user_id FROM platform_provisioning_requests WHERE idempotency_key = 'prov-acme-001'`,
      );
      expect(response.body.data.ownerUserId).toBe(first.owner_user_id);
    });

    /**
     * Falla el último paso (la llave) con usuario, organización, perfil y periodo ya escritos en la
     * transacción: no debe quedar nada, y la clave debe poder reintentarse.
     */
    it('si falla la emisión de la llave, revierte todo y la clave queda libre', async () => {
      const before = await snapshotCounts();
      const spy = jest
        .spyOn(issuePlatformApiKey, 'issueWithin')
        .mockRejectedValueOnce(new Error('fallo simulado al emitir la llave'));
      const payload = body((value) => {
        value.owner.email = 'rollback@acme.test';
        value.billing.externalReference = 'PROVISION-ROLLBACK-001';
      });

      await provision(payload, 'prov-rollback').expect(500);

      expect(await snapshotCounts()).toEqual(before);
      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM users WHERE email = 'rollback@acme.test'`,
      );
      expect(n).toBe(0);

      spy.mockRestore();
      await provision(payload, 'prov-rollback').expect(201);
    });
  });
});

import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { config } from 'dotenv';
import { join } from 'path';
import { Client } from 'pg';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { AccountEntity } from './../src/account/entities/account.entity';
import { ApiKeySecretService } from './../src/api-key/api-key-secret.service';
import { ApiKeyEntity } from './../src/api-key/entities/api-key.entity';
import { ApiKeyPermissionGuard } from './../src/api-key/guards/api-key-permission.guard';
import { OrganizationApiKeyGuard } from './../src/api-key/guards/organization-api-key.guard';
import { AuditService } from './../src/audit/audit.service';
import { GetBiometricSignatureStatusUseCase } from './../src/biometric-signature/applications/get-biometric-signature-status.use-case';
import { StartGuestBiometricSignatureUseCase } from './../src/biometric-signature/applications/start-guest-biometric-signature.use-case';
import { BiometricSignatureAttemptEntity } from './../src/biometric-signature/entities/biometric-signature-attempt.entity';
import { applyGlobalApiPrefix } from './../src/common/constants/api-prefix.constants';
import { EmailService } from './../src/common/email/email.service';
import { OTPService } from './../src/common/otp/otp.service';
import { RedisService } from './../src/common/redis/redis.service';
import { SignDocumentUseCase } from './../src/document/applications/sign-document.use-case';
import { DocumentService } from './../src/document/document.service';
import { CollaboratorEntity } from './../src/document/entities/collaborator.entity';
import { DocumentEntity } from './../src/document/entities/document.entity';
import { GuestSigningAccessEntity } from './../src/document/entities/guest-signing-access.entity';
import { VerificationCodeEntity } from './../src/document/entities/verification-code.entity';
import { CreateIntegrationDocumentUseCase } from './../src/document/integration/applications/create-integration-document.use-case';
import { IssueIntegrationSigningAccessUseCase } from './../src/document/integration/applications/issue-integration-signing-access.use-case';
import { ListOrganizationIntegrationDocumentsUseCase } from './../src/document/integration/applications/list-organization-integration-documents.use-case';
import { ListUserIntegrationDocumentsUseCase } from './../src/document/integration/applications/list-user-integration-documents.use-case';
import { ResendIntegrationSigningInvitationUseCase } from './../src/document/integration/applications/resend-integration-signing-invitation.use-case';
import { IntegrationDocumentsController } from './../src/document/integration/integration-documents.controller';
import { DocumentAuthorizationPolicy } from './../src/document/policies/document-authorization.policy';
import { GuestSigningAccessService } from './../src/document/services/guest-signing-access.service';
import { VerificationCodeService } from './../src/document/verification-code.service';
import { DocumentEventsProducer } from './../src/kafka/document-events.producer';
import { GetSigningInvitationUseCase } from './../src/public-signing/applications/get-signing-invitation.use-case';
import { PublicSigningSessionUseCases } from './../src/public-signing/applications/public-signing-session.use-cases';
import { SigningInvitationAccessUseCases } from './../src/public-signing/applications/signing-invitation-access.use-cases';
import { PublicSigningSessionGuard } from './../src/public-signing/guards/public-signing-session.guard';
import { SigningInvitationAccessGuard } from './../src/public-signing/guards/signing-invitation-access.guard';
import { PublicSigningInvitationsController } from './../src/public-signing/public-signing-invitations.controller';
import { PublicSigningLaunchesController } from './../src/public-signing/public-signing-launches.controller';
import {
  PUBLIC_SIGNING_INVITATION_COOKIE,
  PUBLIC_SIGNING_SESSION_COOKIE,
} from './../src/public-signing/public-signing-session.cookie';
import { PublicSigningSessionsController } from './../src/public-signing/public-signing-sessions.controller';
import { PublicSigningInvitationResolver } from './../src/public-signing/services/public-signing-invitation-resolver.service';
import { PublicSigningSessionTokenService } from './../src/public-signing/services/public-signing-session-token.service';
import { PublicSignerIdentityService } from './../src/public-signing/services/public-signer-identity.service';
import { SigningIdempotencyService } from './../src/public-signing/services/signing-idempotency.service';
import { SigningPolicyResolver } from './../src/public-signing/services/signing-policy.resolver';
import { IdentityVerificationEntity } from './../src/identity-verification/entities/identity-verification.entity';
import { UserEntity } from './../src/user/entities/user.entity';
import { SigningInvitationAccessTokenService } from './../src/public-signing/services/signing-invitation-access-token.service';
import { SigningInvitationEntity } from './../src/signing-invitation/entities/signing-invitation.entity';
import { SigningLaunchTokenEntity } from './../src/signing-invitation/entities/signing-launch-token.entity';
import { SigningInvitationDeliveryService } from './../src/signing-invitation/signing-invitation-delivery.service';
import { SigningInvitationService } from './../src/signing-invitation/signing-invitation.service';
import { SigningLaunchService } from './../src/signing-invitation/signing-launch.service';
import { SigningRateLimitService } from './../src/signing-invitation/signing-rate-limit.service';
import { UploadSignatureImageUseCase } from './../src/signature/applications/upload-signature-image.use-case';
import { StartDiditVerificationUseCase } from './../src/identity-verification/applications/start-didit-verification.use-case';

config({ path: join(__dirname, '..', '.env') });

const HASH = 'f'.repeat(64);
const GEOLOCATION = JSON.stringify({ latitude: 19.43, longitude: -99.13 });

/** Redis en memoria: lo que usan los límites y la idempotencia de la firma. */
function memoryRedis() {
  const store = new Map<string, string>();
  return {
    store,
    exists: async (key: string) => Number(store.has(key)),
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK' as const;
    },
    del: async (key: string) => Number(store.delete(key)),
    setIfAbsent: async (key: string, value: string) => {
      if (store.has(key)) return false;
      store.set(key, value);
      return true;
    },
    incrementWithExpiry: async (key: string) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      return next;
    },
  };
}

/**
 * Acceso a la firma desde el correo y desde el portal del tercero, de punta a punta contra Postgres.
 *
 * Escenario del ticket: un documento secuencial creado por integración con Ana (orden 1) y Juan
 * (orden 2), los dos de firma simple con usuario provisional. Es real todo lo que decide quién
 * puede ver y firmar: la API key y su permiso, la búsqueda del firmante por correo y su turno, las
 * invitaciones y los tokens de lanzamiento (hash, vencimiento, un solo uso), la cookie de acceso,
 * el código del correo (`verification_codes`), la sesión (`guest_signing_accesses`) y la firma
 * (`SignDocumentUseCase`). Son dobles el correo (se lee el código del buzón), Redis (en memoria),
 * la auditoría (se cuentan los eventos) y lo que necesita MinIO, Kafka o el PDF.
 *
 * **No toca `signature_db`**: crea una base propia, le aplica las migraciones y la borra al final.
 */
describe('Acceso a la firma desde correo y portal del tercero (e2e)', () => {
  const DATABASE_NAME = `signature_signing_access_e2e_${process.pid}_${Date.now()}`;
  const baseUrl = process.env.POSTGRES_DB_URL as string;
  const adminUrl = baseUrl.replace(/\/[^/?]+(\?.*)?$/, '/postgres$1');
  const databaseUrl = baseUrl.replace(
    /\/[^/?]+(\?.*)?$/,
    `/${DATABASE_NAME}$1`,
  );

  const ids: Record<string, string> = {};
  const mailbox: Record<string, string[]> = {};
  const audits: { operation: string; result?: string; actor?: any }[] = [];
  let apiKey: string;
  let readOnlyKey: string;
  let app: INestApplication;
  let dataSource: DataSource;
  let invitations: SigningInvitationService;

  async function adminQuery(sql: string): Promise<void> {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  async function permission(resource: string, action: string, scope: string) {
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
    return row.id as string;
  }

  async function seedApiKey(
    secrets: ApiKeySecretService,
    name: string,
    permissionIds: string[],
    organizationKey = 'org',
  ): Promise<string> {
    const generated = secrets.generate();
    const [key] = await dataSource.query(
      `INSERT INTO api_keys (organization_id, created_by_account_id, public_id, key_prefix, secret_hash, name, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE') RETURNING id`,
      [
        ids[organizationKey],
        ids[`${organizationKey}:actorAccount`],
        generated.publicId,
        generated.keyPrefix,
        generated.secretHash,
        name,
      ],
    );
    for (const permissionId of permissionIds) {
      await dataSource.query(
        `INSERT INTO api_key_permissions (api_key_id, permission_id) VALUES ($1, $2)`,
        [key.id, permissionId],
      );
    }
    ids[`key:${name}`] = key.id;
    return generated.key;
  }

  /** Usuario PROVISIONED (con su credencial ya completa) y su cuenta personal. */
  async function seedProvisionalSigner(name: string, email: string) {
    const [user] = await dataSource.query(
      `INSERT INTO users (first_name, last_name, email, roles, lifecycle_status, signing_credential_status, national_id, password, personal_information_id, is_email_verified)
       VALUES ($1, 'E2E', $2, 'signer', 'PROVISIONED', 'CONFIGURED', NULL, NULL, NULL, false) RETURNING id`,
      [name, email],
    );
    ids[`user:${name}`] = user.id;
    const [account] = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, organization_id, role_id, email, password)
       SELECT $1, 'PERSONAL', NULL, r.id, $2, NULL FROM roles r WHERE r.name = 'OWNER' AND r.is_system_role = true
       RETURNING id`,
      [user.id, email],
    );
    return account.id as string;
  }

  /** Verificación de identidad de Didit aprobada, con el nombre que leyó de la identificación. */
  async function approveIdentity(name: string, fullName: string) {
    await dataSource.query(
      `INSERT INTO identity_verifications (user_id, provider, status, decision, completed_at)
       VALUES ($1, 'DIDIT', 'APPROVED', $2, now())`,
      [
        ids[`user:${name}`],
        JSON.stringify({ id_verifications: [{ full_name: fullName }] }),
      ],
    );
  }

  /** Documento secuencial creado por integración, con Ana (1) y Juan (2), los dos SIMPLE. */
  async function seedSequentialDocument(): Promise<void> {
    const [document] = await dataSource.query(
      `INSERT INTO documents (object_key, file_name, file_type, total_pages, ip_address, original_hash, status, created_by, account_id, organization_id, total_signers, signature_type, is_sequential, requires_verification, created_via_api_key_id)
       VALUES ('contrato.pdf', 'contrato.pdf', 'application/pdf', 1, '127.0.0.1', $1, 'PENDING_SIGNATURE', $2, $3, $4, 2, 'SIMPLE', true, true, $5) RETURNING id`,
      [HASH, ids.actorUser, ids.actorAccount, ids.org, ids['key:portal']],
    );
    ids.document = document.id;
    for (const [name, order] of [
      ['ana', 0],
      ['juan', 1],
    ] as const) {
      const email = `${name}@correo.test`;
      const accountId = await seedProvisionalSigner(name, email);
      const [collaborator] = await dataSource.query(
        `INSERT INTO collaborators (document_id, account_id, email, colaborator_type, signature_type, status, signing_order, ip_address)
         VALUES ($1, $2, $3, 'SIGNER', 'SIMPLE', 'PENDING', $4, '127.0.0.1') RETURNING id`,
        [document.id, accountId, email, order],
      );
      ids[name] = collaborator.id;
    }
    // Ana ya validó su identidad; Juan todavía no (ver su caso).
    await approveIdentity('ana', 'ANA E2E LOPEZ');
  }

  /** Cookie (`nombre=valor`) de una respuesta, o `undefined`. */
  function cookieFrom(response: request.Response, name: string) {
    const cookies =
      (response.headers['set-cookie'] as unknown as string[]) ?? [];
    return cookies
      .find(
        (value) =>
          value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`),
      )
      ?.split(';')[0];
  }

  function lastCode(email: string): string {
    const codes = mailbox[email] ?? [];
    return codes[codes.length - 1];
  }

  /** Pide un acceso temporal para un correo desde el "backend del tercero". */
  function signingAccess(email: string, key = apiKey) {
    return request(app.getHttpServer())
      .post(`/api/v1/integration/documents/${ids.document}/signing-access`)
      .set('X-API-Key', key)
      .send({ email });
  }

  /** Abre la URL temporal: canjea el token en el navegador. */
  function openLaunch(url: string) {
    const token = new URL(url).pathname.split('/').pop()!;
    return request(app.getHttpServer()).post(
      `/api/v1/public/signing-launches/${token}/access`,
    );
  }

  /** Pide el código con la cookie de acceso y lo valida; devuelve la cookie de sesión. */
  async function validateCode(
    invitationCookie: string,
    email: string,
  ): Promise<string> {
    await request(app.getHttpServer())
      .post('/api/v1/public/signing-invitations/current/otp')
      .set('Cookie', invitationCookie)
      .expect(200);
    const verified = await request(app.getHttpServer())
      .post('/api/v1/public/signing-invitations/current/otp/verify')
      .set('Cookie', invitationCookie)
      .send({ code: lastCode(email) })
      .expect(200);
    return cookieFrom(verified, PUBLIC_SIGNING_SESSION_COOKIE)!;
  }

  function signSimple(sessionCookie: string, idempotencyKey: string) {
    return request(app.getHttpServer())
      .post('/api/v1/public/signing-sessions/current/simple/sign')
      .set('Cookie', sessionCookie)
      .set('Idempotency-Key', idempotencyKey)
      .field('documentHash', HASH)
      .field('geolocation', GEOLOCATION);
  }

  beforeAll(async () => {
    process.env.API_KEY_PEPPER =
      'pepper-de-la-e2e-de-acceso-a-firma-con-mas-de-32-caracteres';
    process.env.JWT_SECRET = 'jwt-secret-e2e-acceso-a-firma';
    process.env.PUBLIC_WEB_APP_URL = 'https://app.firmalo.test';
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

    const documentService = {
      findOne: (id: string) =>
        dataSource
          .getRepository(DocumentEntity)
          .findOneOrFail({ where: { id } }),
      assertCanSignWithSimpleSignature:
        DocumentService.prototype.assertCanSignWithSimpleSignature,
      snapshotSignatureImage: async () => 'snapshots/rubrica.png',
      finalizeSignedDocument: async (document: DocumentEntity) => {
        await dataSource
          .getRepository(DocumentEntity)
          .update(document.id, { status: 'SIGNED' as never });
      },
      refreshPartiallySignedPreview: async () => undefined,
      notifyNextSigner: async () => undefined,
      getDocumentMinioURL: async () => ({
        secureUrl: 'https://minio.test/contrato.pdf?firma=x',
        expiresIn: 300,
      }),
    };

    @Module({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ThrottlerModule.forRoot([{ ttl: 60000, limit: 1000 }]),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: databaseUrl,
          entities: [join(__dirname, '..', 'src', '**', '*.entity{.ts,.js}')],
        }),
        TypeOrmModule.forFeature([
          DocumentEntity,
          CollaboratorEntity,
          AccountEntity,
          ApiKeyEntity,
          VerificationCodeEntity,
          GuestSigningAccessEntity,
          BiometricSignatureAttemptEntity,
          SigningInvitationEntity,
          SigningLaunchTokenEntity,
          IdentityVerificationEntity,
          UserEntity,
        ]),
      ],
      controllers: [
        IntegrationDocumentsController,
        PublicSigningInvitationsController,
        PublicSigningLaunchesController,
        PublicSigningSessionsController,
      ],
      providers: [
        // Integración: API key real, permiso real, búsqueda real del firmante.
        ApiKeySecretService,
        OrganizationApiKeyGuard,
        ApiKeyPermissionGuard,
        IssueIntegrationSigningAccessUseCase,
        { provide: ListOrganizationIntegrationDocumentsUseCase, useValue: {} },
        { provide: ListUserIntegrationDocumentsUseCase, useValue: {} },
        { provide: CreateIntegrationDocumentUseCase, useValue: {} },
        { provide: ResendIntegrationSigningInvitationUseCase, useValue: {} },
        // Invitaciones, lanzamientos, código, sesión y firma: reales.
        SigningInvitationService,
        SigningLaunchService,
        SigningRateLimitService,
        PublicSigningInvitationResolver,
        SigningInvitationAccessTokenService,
        PublicSigningSessionTokenService,
        SigningInvitationAccessGuard,
        PublicSigningSessionGuard,
        GetSigningInvitationUseCase,
        SigningInvitationAccessUseCases,
        PublicSigningSessionUseCases,
        SigningPolicyResolver,
        PublicSignerIdentityService,
        SigningIdempotencyService,
        SignDocumentUseCase,
        VerificationCodeService,
        GuestSigningAccessService,
        OTPService,
        // Dobles.
        { provide: RedisService, useValue: memoryRedis() },
        {
          provide: EmailService,
          useValue: {
            sendVerificationCodeNotification: async (
              to: string,
              _file: string,
              code: string,
            ) => {
              (mailbox[to] ??= []).push(code);
            },
          },
        },
        {
          provide: AuditService,
          useValue: { create: async (payload: any) => audits.push(payload) },
        },
        { provide: DocumentService, useValue: documentService },
        {
          provide: DocumentEventsProducer,
          useValue: {
            emitSigned: () => undefined,
            emitCollaboratorSigned: () => undefined,
          },
        },
        {
          provide: DocumentAuthorizationPolicy,
          useValue: { assertCanSign: () => undefined },
        },
        { provide: SigningInvitationDeliveryService, useValue: {} },
        { provide: StartDiditVerificationUseCase, useValue: {} },
        { provide: UploadSignatureImageUseCase, useValue: {} },
        { provide: StartGuestBiometricSignatureUseCase, useValue: {} },
        { provide: GetBiometricSignatureStatusUseCase, useValue: {} },
      ],
    })
    class SigningAccessE2eModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [SigningAccessE2eModule],
    }).compile();
    app = moduleRef.createNestApplication();
    applyGlobalApiPrefix(app);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    invitations = app.get(SigningInvitationService);

    const [organization] = await dataSource.query(
      `INSERT INTO organizations (name, display_name, is_active) VALUES ('Portal ERP', 'Portal ERP', true) RETURNING id`,
    );
    ids.org = organization.id;
    const [info] = await dataSource.query(
      `INSERT INTO personal_information (name, last_name, curp) VALUES ('actor', 'E2E', 'CURPACTOR000000000') RETURNING id`,
    );
    const [actor] = await dataSource.query(
      `INSERT INTO users (first_name, last_name, email, roles, national_id, password, personal_information_id)
       VALUES ('actor', 'E2E', 'actor@erp.test', 'user', 'NIDACTOR', 'x', $1) RETURNING id`,
      [info.id],
    );
    ids.actorUser = actor.id;
    const [account] = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, organization_id, role_id, email, password, is_active)
       SELECT $1, 'ORGANIZATION', $2, r.id, 'actor@erp.test', 'x', true FROM roles r WHERE r.name = 'OWNER' AND r.is_system_role = true
       RETURNING id`,
      [actor.id, ids.org],
    );
    ids.actorAccount = account.id;

    // Sólo puede haber una llave activa por organización: la de sólo lectura vive en otra.
    ids['org:actorAccount'] = ids.actorAccount;
    const [otherOrganization] = await dataSource.query(
      `INSERT INTO organizations (name, display_name, is_active) VALUES ('Otro ERP', 'Otro ERP', true) RETURNING id`,
    );
    ids.otherOrg = otherOrganization.id;
    const [otherAccount] = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, organization_id, role_id, email, password, is_active)
       SELECT $1, 'ORGANIZATION', $2, r.id, 'actor@erp.test', 'x', true FROM roles r WHERE r.name = 'OWNER' AND r.is_system_role = true
       RETURNING id`,
      [actor.id, ids.otherOrg],
    );
    ids['otherOrg:actorAccount'] = otherAccount.id;

    const secrets = app.get(ApiKeySecretService);
    apiKey = await seedApiKey(secrets, 'portal', [
      await permission('DOCUMENT', 'CREATE', 'ORGANIZATION'),
    ]);
    readOnlyKey = await seedApiKey(
      secrets,
      'solo-lectura',
      [await permission('DOCUMENT', 'READ', 'ORGANIZATION')],
      'otherOrg',
    );
    await seedSequentialDocument();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await dataSource?.destroy();
    await adminQuery(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE_NAME}' AND pid <> pg_backend_pid()`,
    );
    await adminQuery(`DROP DATABASE IF EXISTS "${DATABASE_NAME}"`);
  });

  it('Juan no obtiene acceso del portal antes de que Ana firme (409 WAITING_FOR_PREVIOUS_SIGNER)', async () => {
    const response = await signingAccess('juan@correo.test').expect(409);
    expect(response.body.error.code).toBe('WAITING_FOR_PREVIOUS_SIGNER');
    const [{ count }] = await dataSource.query(
      `SELECT count(*)::int AS count FROM signing_launch_tokens`,
    );
    expect(count).toBe(0);
  });

  it('Juan abre la invitación de SU correo antes de tiempo: estado controlado, sin cookie ni datos', async () => {
    const { token } = await invitations.issue({
      documentId: ids.document,
      collaboratorId: ids.juan,
    });

    const response = await request(app.getHttpServer())
      .post(`/api/v1/public/signing-invitations/${token}/access`)
      .expect(200);

    expect(response.body).toEqual({ status: 'WAITING_FOR_PREVIOUS_SIGNER' });
    expect(
      cookieFrom(response, PUBLIC_SIGNING_INVITATION_COOKIE),
    ).toBeUndefined();
  });

  it('una llave sin DOCUMENT.CREATE no obtiene acceso', async () => {
    await signingAccess('ana@correo.test', readOnlyKey).expect(403);
  });

  describe('Ana desde el portal del tercero', () => {
    let launchUrl: string;
    let invitationCookie: string;
    let sessionCookie: string;

    it('el tercero obtiene una URL /sign/launch de 5 minutos; sólo se guarda el hash', async () => {
      const response = await signingAccess('ANA@correo.test').expect(200);

      launchUrl = response.body.data.url;
      expect(launchUrl).toMatch(
        /^https:\/\/app\.firmalo\.test\/sign\/launch\/sla_[A-Za-z0-9_-]{43}$/,
      );
      const token = launchUrl.split('/').pop()!;
      const [row] = await dataSource.query(
        `SELECT token_hash, expires_at - issued_at AS ttl, issued_via_api_key_id FROM signing_launch_tokens`,
      );
      expect(row.token_hash).not.toContain(token);
      expect(row.ttl).toEqual(expect.objectContaining({ minutes: 5 }));
      expect(row.issued_via_api_key_id).toBe(ids['key:portal']);
      expect(audits.map(({ operation }) => operation)).toContain(
        'SIGNING_LAUNCH_ISSUED',
      );
    });

    it('abrir la URL muestra el correo enmascarado y deja la cookie de acceso, sin el PDF', async () => {
      const response = await openLaunch(launchUrl).expect(200);

      expect(response.body).toEqual(
        expect.objectContaining({
          status: 'ACTIVE',
          signer: expect.objectContaining({ maskedEmail: 'a***@correo.test' }),
        }),
      );
      expect(JSON.stringify(response.body)).not.toMatch(/minio|\.pdf\?/);
      invitationCookie = cookieFrom(
        response,
        PUBLIC_SIGNING_INVITATION_COOKIE,
      )!;
      expect(invitationCookie).toBeDefined();
    });

    it('el token de lanzamiento es de un solo uso', async () => {
      const reused = await openLaunch(launchUrl).expect(404);
      expect(reused.body.message).toBe('Esta invitación no es válida.');
    });

    it('sin validar el código no hay sesión: ni documento ni firma', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/public/signing-sessions/current/document')
        .set('Cookie', invitationCookie)
        .expect(401);
      await signSimple(invitationCookie, 'sin-sesion').expect(401);
    });

    it('quien recibe la URL pero no controla el correo de Ana no abre sesión', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/public/signing-invitations/current/otp')
        .set('Cookie', invitationCookie)
        .expect(200);
      // El código llegó al correo de Ana, no al de quien abrió la URL.
      expect(mailbox['ana@correo.test']).toHaveLength(1);
      expect(mailbox['juan@correo.test']).toBeUndefined();

      const wrong = await request(app.getHttpServer())
        .post('/api/v1/public/signing-invitations/current/otp/verify')
        .set('Cookie', invitationCookie)
        .send({
          code: lastCode('ana@correo.test') === '000000' ? '111111' : '000000',
        })
        .expect(400);
      expect(cookieFrom(wrong, PUBLIC_SIGNING_SESSION_COOKIE)).toBeUndefined();
    });

    it('con el código de su correo, Ana abre la sesión y ve su documento', async () => {
      const verified = await request(app.getHttpServer())
        .post('/api/v1/public/signing-invitations/current/otp/verify')
        .set('Cookie', invitationCookie)
        .send({ code: lastCode('ana@correo.test') })
        .expect(200);
      sessionCookie = cookieFrom(verified, PUBLIC_SIGNING_SESSION_COOKIE)!;
      expect(sessionCookie).toBeDefined();

      const current = await request(app.getHttpServer())
        .get('/api/v1/public/signing-sessions/current')
        .set('Cookie', sessionCookie)
        .expect(200);
      expect(current.body.signer).toEqual(
        expect.objectContaining({
          canSign: true,
          maskedEmail: 'a***@correo.test',
        }),
      );
      expect(current.body.status).toBe('READY_TO_SIGN');
      expect(current.body.signature).toEqual(
        expect.objectContaining({
          type: 'SIMPLE',
          requiresIdentityValidation: true,
          identityProvider: 'DIDIT',
          requiresCertificateValidation: false,
        }),
      );
      expect(current.body.signature.identityVerification).toEqual(
        expect.objectContaining({ status: 'APPROVED', satisfied: true }),
      );

      const document = await request(app.getHttpServer())
        .get('/api/v1/public/signing-sessions/current/document')
        .set('Cookie', sessionCookie)
        .expect(200);
      expect(document.body.documentHash).toBe(HASH);
    });

    it('Ana firma (con Idempotency-Key) y un reintento devuelve la misma respuesta', async () => {
      const signed = await signSimple(sessionCookie, 'firma-ana-1').expect(200);
      expect(signed.body.data).toEqual({
        id: ids.document,
        documentCompleted: false,
      });
      const replay = await signSimple(sessionCookie, 'firma-ana-1').expect(200);
      expect(replay.body).toEqual(signed.body);

      const [ana] = await dataSource.query(
        `SELECT status, signing_authorization FROM collaborators WHERE id = $1`,
        [ids.ana],
      );
      expect(ana).toEqual({
        status: 'SIGNED',
        signing_authorization: 'GUEST_EMAIL_OTP',
      });
      const operations = audits.map(({ operation }) => operation);
      expect(operations).toEqual(
        expect.arrayContaining([
          'SIGNING_INVITATION_OTP_SENT',
          'SIGNING_INVITATION_OTP_VERIFIED',
          'SIGNING_STARTED',
          'IDENTITY_VERIFICATION_CHECKED',
          'DOCUMENT_SIGNED',
        ]),
      );
      const signedAudit = audits.find(
        ({ operation }) => operation === 'DOCUMENT_SIGNED',
      );
      expect(signedAudit?.actor).toEqual(
        expect.objectContaining({
          type: 'PUBLIC_INVITATION',
          collaboratorId: ids.ana,
          accessChannel: 'THIRD_PARTY_PORTAL',
        }),
      );
    });

    it('con la sesión ya usada no se puede volver a firmar con otra clave', async () => {
      const again = await signSimple(sessionCookie, 'firma-ana-2').expect(409);
      expect(again.body).toEqual({
        statusCode: 409,
        error: 'Conflict',
        code: 'SIGNING_NOT_AVAILABLE',
        message: 'Ya respondiste a esta solicitud de firma.',
      });
    });
  });

  describe('Juan desde su correo, ya en turno', () => {
    it('termina en la misma sesión pública y firma; el documento queda completo', async () => {
      const { token } = await invitations.issue({
        documentId: ids.document,
        collaboratorId: ids.juan,
      });
      const opened = await request(app.getHttpServer())
        .post(`/api/v1/public/signing-invitations/${token}/access`)
        .expect(200);
      expect(opened.body.status).toBe('ACTIVE');

      const sessionCookie = await validateCode(
        cookieFrom(opened, PUBLIC_SIGNING_INVITATION_COOKIE)!,
        'juan@correo.test',
      );

      // Sin identidad validada no firma: el código lo dice y la sesión lo refleja.
      const blocked = await signSimple(sessionCookie, 'firma-juan-0').expect(
        403,
      );
      expect(blocked.body).toEqual(
        expect.objectContaining({
          statusCode: 403,
          code: 'IDENTITY_VERIFICATION_REQUIRED',
        }),
      );
      const pending = await request(app.getHttpServer())
        .get(
          '/api/v1/public/signing-sessions/current/simple/identity-verification',
        )
        .set('Cookie', sessionCookie)
        .expect(200);
      expect(pending.body).toEqual(
        expect.objectContaining({ status: 'NOT_STARTED', satisfied: false }),
      );

      // Didit aprueba a otra persona: los datos no corresponden.
      await approveIdentity('juan', 'PEDRO RAMIREZ');
      const mismatch = await signSimple(sessionCookie, 'firma-juan-m').expect(
        403,
      );
      expect(mismatch.body.code).toBe('IDENTITY_DATA_MISMATCH');

      await approveIdentity('juan', 'JUAN E2E GARCIA');
      const signed = await signSimple(sessionCookie, 'firma-juan-1').expect(
        200,
      );
      expect(signed.body.data.documentCompleted).toBe(true);

      const signedAudit = audits
        .filter(({ operation }) => operation === 'DOCUMENT_SIGNED')
        .pop();
      expect(signedAudit?.actor.accessChannel).toBe('EMAIL');
    });

    it('después de firmar, su enlace muestra la firma completada', async () => {
      const { token } = await invitations.issue({
        documentId: ids.document,
        collaboratorId: ids.juan,
      });
      await request(app.getHttpServer())
        .post(`/api/v1/public/signing-invitations/${token}/access`)
        .expect(200, { status: 'ALREADY_SIGNED' });
    });
  });

  it('un token de lanzamiento vencido no abre nada', async () => {
    const issued = await app.get(SigningLaunchService).issue({
      invitationId: (
        await invitations.ensureOpen({
          documentId: ids.document,
          collaboratorId: ids.ana,
        })
      ).id,
      apiKeyId: null,
      ipAddress: null,
    });
    await dataSource.query(
      `UPDATE signing_launch_tokens SET issued_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' WHERE id = $1`,
      [issued.launch.id],
    );

    await openLaunch(issued.url).expect(404);
  });
});

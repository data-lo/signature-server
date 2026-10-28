import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';

import { AccountEntity } from './../src/account/entities/account.entity';
import { ApiKeySecretService } from './../src/api-key/api-key-secret.service';
import { CreateOrganizationApiKeyUseCase } from './../src/api-key/applications/create-organization-api-key.use-case';
import { GetCurrentOrganizationApiKeyUseCase } from './../src/api-key/applications/get-current-organization-api-key.use-case';
import { ListOrganizationApiKeysUseCase } from './../src/api-key/applications/list-organization-api-keys.use-case';
import { RevokeOrganizationApiKeyUseCase } from './../src/api-key/applications/revoke-organization-api-key.use-case';
import { RotateOrganizationApiKeyUseCase } from './../src/api-key/applications/rotate-organization-api-key.use-case';
import { ApiKeyEntity } from './../src/api-key/entities/api-key.entity';
import { ApiKeyStatusEnum } from './../src/api-key/enums/api-key-status.enum';
import { ApiKeyPermissionGuard } from './../src/api-key/guards/api-key-permission.guard';
import { OrganizationApiKeyGuard } from './../src/api-key/guards/organization-api-key.guard';
import { OrganizationApiKeysController } from './../src/api-key/organization-api-keys.controller';
import { JwtAuthGuard } from './../src/auth/guards/jwt-auth.guard';
import { REQUIRED_PERMISSION_METADATA } from './../src/authorization/constants/permission-metadata.constant';
import { RedisService } from './../src/common/redis/redis.service';
import { applyGlobalApiPrefix } from './../src/common/constants/api-prefix.constants';
import { CreateIntegrationDocumentUseCase } from './../src/document/integration/applications/create-integration-document.use-case';
import { ListOrganizationIntegrationDocumentsUseCase } from './../src/document/integration/applications/list-organization-integration-documents.use-case';
import { ListUserIntegrationDocumentsUseCase } from './../src/document/integration/applications/list-user-integration-documents.use-case';
import { ResendIntegrationSigningInvitationUseCase } from './../src/document/integration/applications/resend-integration-signing-invitation.use-case';
import { IntegrationDocumentsController } from './../src/document/integration/integration-documents.controller';
import { COLABORATOR_TYPE_ENUM } from './../src/document/enum/colaborator-type.enum';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from './../src/document/enum/guest-signing-access-purpose.enum';
import { SIGNATURE_TYPE_ENUM } from './../src/document/enum/signature-type.enum';
import { GuestSigningAccessService } from './../src/document/services/guest-signing-access.service';
import { GetSigningInvitationUseCase } from './../src/public-signing/applications/get-signing-invitation.use-case';
import { PublicSigningSessionUseCases } from './../src/public-signing/applications/public-signing-session.use-cases';
import { SigningInvitationAccessUseCases } from './../src/public-signing/applications/signing-invitation-access.use-cases';
import { PublicSigningSessionGuard } from './../src/public-signing/guards/public-signing-session.guard';
import {
  PUBLIC_SIGNING_INVITATION_COOKIE,
  PUBLIC_SIGNING_SESSION_COOKIE,
} from './../src/public-signing/public-signing-session.cookie';
import { PublicSigningInvitationsController } from './../src/public-signing/public-signing-invitations.controller';
import { PublicSigningLaunchesController } from './../src/public-signing/public-signing-launches.controller';
import { SigningInvitationAccessGuard } from './../src/public-signing/guards/signing-invitation-access.guard';
import { PublicSigningInvitationResolver } from './../src/public-signing/services/public-signing-invitation-resolver.service';
import { SigningInvitationAccessTokenService } from './../src/public-signing/services/signing-invitation-access-token.service';
import { IssueIntegrationSigningAccessUseCase } from './../src/document/integration/applications/issue-integration-signing-access.use-case';
import { PublicSigningSessionsController } from './../src/public-signing/public-signing-sessions.controller';
import { PublicSigningSessionTokenService } from './../src/public-signing/services/public-signing-session-token.service';
import { SigningInvitationService } from './../src/signing-invitation/signing-invitation.service';
import { USER_LIFECYCLE_STATUS_ENUM } from './../src/user/enums/user-lifecycle-status.enum';

const JWT_SECRET = 'jwt-secret-e2e-audiencias';
const PEPPER = 'pepper-de-la-e2e-de-audiencias-con-mas-de-32-caracteres';
const INVITATION_TOKEN = 'q3VbX7f0_Lr9-ZtKp2NcWm4YhA8sDe1JuGo6BiQk5Rv';
const LAUNCH_TOKEN = `sla_${INVITATION_TOKEN}`;
const ORG_ID = '7a1f0c2e-1111-4a5b-8c9d-0123456789ab';
const DOC_ID = '3c6e2b9a-2222-4c1d-9e8f-0123456789ab';
const COLLAB_ID = '9d8c7b6a-3333-4e2f-8a1b-0123456789ab';

/**
 * Hace las veces de `PermissionsGuard` (que lee roles de la base): en una ruta con
 * `@RequirePermission` deja el contexto de autorización del usuario del JWT. Sólo puede correr
 * DESPUÉS de `JwtAuthGuard`, así que sin JWT nunca llega a ejecutarse.
 */
@Injectable()
class FakePermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride(
      REQUIRED_PERMISSION_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;
    const req = context.switchToHttp().getRequest();
    req.authorization = {
      userId: req.user.sub,
      accountId: 'acc-admin',
      organizationId: req.params.organizationId,
      roleId: 'role-admin',
    };
    return true;
  }
}

/**
 * Las tres audiencias de la capa HTTP, cada una con SU mecanismo, sobre HTTP de verdad: guards
 * reales (`JwtAuthGuard` global, `OrganizationApiKeyGuard` + `ApiKeyPermissionGuard`,
 * `PublicSigningSessionGuard`) y casos de uso dobles. Lo que se fija es la separación: ninguna
 * credencial de una audiencia abre las rutas de otra, y la autoridad (organización, permisos,
 * colaborador) sale siempre del mecanismo, nunca del request.
 *
 * No toca bases de datos: los repositorios del guard de API key son dobles en memoria.
 */
describe('Audiencias HTTP: interna, integración y firma pública (e2e)', () => {
  const secrets = new ApiKeySecretService({
    get: () => PEPPER,
  } as unknown as ConfigService);
  const fullKey = secrets.generate();
  const readOnlyKey = secrets.generate();
  const sessionTokens = new PublicSigningSessionTokenService({
    get: () => JWT_SECRET,
  } as unknown as ConfigService);
  const accessTokens = new SigningInvitationAccessTokenService({
    get: () => JWT_SECRET,
  } as unknown as ConfigService);

  const permission = (resource: string, action: string, scope: string) => ({
    scope,
    resource: { key: resource },
    action: { key: action },
  });
  const storedKeys = new Map(
    [
      {
        issued: fullKey,
        id: 'key-full',
        permissions: [
          permission('DOCUMENT', 'READ', 'ORGANIZATION'),
          permission('DOCUMENT', 'CREATE', 'ORGANIZATION'),
        ],
      },
      {
        issued: readOnlyKey,
        id: 'key-read',
        permissions: [permission('DOCUMENT', 'READ', 'OWN')],
      },
    ].map(({ issued, id, permissions }) => [
      issued.publicId,
      {
        id,
        name: `Llave ${id}`,
        organizationId: ORG_ID,
        createdByAccountId: 'acc-actor',
        publicId: issued.publicId,
        keyPrefix: issued.keyPrefix,
        secretHash: issued.secretHash,
        status: ApiKeyStatusEnum.ACTIVE,
        expiresAt: null,
        organization: { id: ORG_ID, isActive: true },
        permissions,
      },
    ]),
  );

  const internal = {
    create: { execute: jest.fn(async () => ({ secret: 'solo-al-crear' })) },
    current: { execute: jest.fn(async () => ({ id: 'key-full' })) },
  };
  const integration = {
    listOrganization: { execute: jest.fn(async () => ({ success: true })) },
    listUser: {
      execute: jest.fn(),
      executeByEmail: jest.fn(async () => ({ success: true })),
    },
    resend: { execute: jest.fn(async () => ({ success: true })) },
    signingAccess: { execute: jest.fn(async () => ({ success: true })) },
  };
  const publicSigning = {
    invitation: { execute: jest.fn(async () => ({ status: 'ACTIVE' })) },
    access: {
      openWithInvitationToken: jest.fn(),
      openWithLaunchToken: jest.fn(),
      requestCode: jest.fn(),
      verifyCode: jest.fn(),
      renew: jest.fn(async () => ({ message: 'ok' })),
    },
    sessions: {
      current: jest.fn(async () => ({ document: { name: 'contrato.pdf' } })),
      document: jest.fn(),
      verifyIdentity: jest.fn(),
      signSimple: jest.fn(async () => ({ success: true })),
      signAdvanced: jest.fn(),
      signBiometric: jest.fn(),
    },
  };
  const sessionAccess = {
    id: 'session-1',
    documentId: DOC_ID,
    collaboratorId: COLLAB_ID,
    purpose: GUEST_SIGNING_ACCESS_PURPOSE_ENUM.PUBLIC_SIGNING_SESSION,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  };

  let app: INestApplication;
  let platformJwt: string;

  beforeAll(async () => {
    publicSigning.access.verifyCode.mockImplementation(
      async (_resolved: unknown, channel: 'EMAIL' | 'THIRD_PARTY_PORTAL') =>
        sessionTokens.issue(sessionAccess as never, 'inv-1', channel),
    );
    publicSigning.access.openWithInvitationToken.mockImplementation(
      async () => ({
        context: { status: 'ACTIVE' },
        access: accessTokens.issue({ invitationId: 'inv-1', channel: 'EMAIL' }),
      }),
    );
    publicSigning.access.openWithLaunchToken.mockImplementation(async () => ({
      context: { status: 'ACTIVE' },
      access: accessTokens.issue({
        invitationId: 'inv-1',
        channel: 'THIRD_PARTY_PORTAL',
      }),
    }));

    @Module({
      imports: [
        JwtModule.register({ secret: JWT_SECRET }),
        ThrottlerModule.forRoot([{ ttl: 60000, limit: 1000 }]),
      ],
      controllers: [
        OrganizationApiKeysController,
        IntegrationDocumentsController,
        PublicSigningInvitationsController,
        PublicSigningLaunchesController,
        PublicSigningSessionsController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: FakePermissionsGuard },
        {
          provide: RedisService,
          useValue: { exists: async () => false, get: async () => null },
        },
        // Interna (JWT)
        { provide: CreateOrganizationApiKeyUseCase, useValue: internal.create },
        { provide: ListOrganizationApiKeysUseCase, useValue: {} },
        {
          provide: GetCurrentOrganizationApiKeyUseCase,
          useValue: internal.current,
        },
        { provide: RotateOrganizationApiKeyUseCase, useValue: {} },
        { provide: RevokeOrganizationApiKeyUseCase, useValue: {} },
        // Integración (X-API-Key)
        OrganizationApiKeyGuard,
        ApiKeyPermissionGuard,
        { provide: ApiKeySecretService, useValue: secrets },
        {
          provide: getRepositoryToken(ApiKeyEntity),
          useValue: {
            findOne: async ({ where }: { where: { publicId: string } }) =>
              storedKeys.get(where.publicId) ?? null,
            update: async () => ({ affected: 1 }),
          },
        },
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: {
            findOne: async () => ({ id: 'acc-actor', userId: 'user-actor' }),
          },
        },
        {
          provide: ListOrganizationIntegrationDocumentsUseCase,
          useValue: integration.listOrganization,
        },
        {
          provide: ListUserIntegrationDocumentsUseCase,
          useValue: integration.listUser,
        },
        { provide: CreateIntegrationDocumentUseCase, useValue: {} },
        {
          provide: ResendIntegrationSigningInvitationUseCase,
          useValue: integration.resend,
        },
        // Firma pública (token de invitación → cookie de sesión)
        PublicSigningSessionGuard,
        { provide: PublicSigningSessionTokenService, useValue: sessionTokens },
        {
          provide: GuestSigningAccessService,
          useValue: {
            findUsable: async (id: string) =>
              id === sessionAccess.id ? sessionAccess : null,
          },
        },
        {
          provide: SigningInvitationService,
          useValue: {
            findById: async () => ({
              id: 'inv-1',
              documentId: DOC_ID,
              collaboratorId: COLLAB_ID,
              revokedAt: null,
              document: { id: DOC_ID, organizationId: ORG_ID },
              collaborator: {
                id: COLLAB_ID,
                colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
                signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
                accountId: 'acc-prov',
                account: {
                  userId: 'user-prov',
                  user: {
                    lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
                  },
                },
              },
            }),
          },
        },
        {
          provide: GetSigningInvitationUseCase,
          useValue: publicSigning.invitation,
        },
        {
          provide: SigningInvitationAccessUseCases,
          useValue: publicSigning.access,
        },
        // Pasos previos a la sesión: cookie de acceso a la invitación (guard y token reales).
        SigningInvitationAccessGuard,
        {
          provide: SigningInvitationAccessTokenService,
          useValue: accessTokens,
        },
        {
          provide: PublicSigningInvitationResolver,
          useValue: {
            resolveById: async () => ({ invitation: { id: 'inv-1' } }),
          },
        },
        {
          provide: IssueIntegrationSigningAccessUseCase,
          useValue: integration.signingAccess,
        },
        {
          provide: PublicSigningSessionUseCases,
          useValue: publicSigning.sessions,
        },
      ],
    })
    class AudiencesE2eModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [AudiencesE2eModule],
    }).compile();
    app = moduleRef.createNestApplication();
    applyGlobalApiPrefix(app);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    platformJwt = app
      .get(JwtService)
      .sign({ sub: 'user-admin', email: 'admin@acme.mx', jti: 'jti-1' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  /** Cookie (`nombre=valor`) que dejó una respuesta, por nombre. */
  function cookieFrom(response: request.Response, name: string): string {
    const cookies = response.headers['set-cookie'] as unknown as string[];
    const cookie = cookies.find((value) => value.startsWith(`${name}=`));
    if (!cookie) throw new Error(`Sin cookie ${name}`);
    return cookie.split(';')[0];
  }

  /**
   * Canjea el token inicial (correo o portal) y valida el código con la cookie de acceso.
   *
   * @param accessRoute - Ruta de canje.
   * @returns La cookie de la sesión pública.
   */
  async function openSessionCookie(
    accessRoute = `/api/v1/public/signing-invitations/${INVITATION_TOKEN}/access`,
  ): Promise<string> {
    const opened = await request(app.getHttpServer())
      .post(accessRoute)
      .expect(200);
    const response = await request(app.getHttpServer())
      .post('/api/v1/public/signing-invitations/current/otp/verify')
      .set('Cookie', cookieFrom(opened, PUBLIC_SIGNING_INVITATION_COOKIE))
      .send({ code: '123456' })
      .expect(200);
    return cookieFrom(response, PUBLIC_SIGNING_SESSION_COOKIE);
  }

  describe('1. Administración interna de API keys (JWT)', () => {
    const route = `/api/v1/organizations/${ORG_ID}/api-keys/current`;

    it('con JWT de la plataforma responde y la organización es la de la ruta autorizada', async () => {
      await request(app.getHttpServer())
        .get(route)
        .set('Authorization', `Bearer ${platformJwt}`)
        .expect(200);
      expect(internal.current.execute).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: ORG_ID }),
      );
    });

    it.each([
      ['sin credenciales', {}],
      ['con una API key de organización', { 'X-API-Key': fullKey.key }],
      [
        'con la cookie de una sesión pública de firma',
        {
          Cookie: `${PUBLIC_SIGNING_SESSION_COOKIE}=${sessionTokens.issue(sessionAccess as never, 'inv-1', 'EMAIL').token}`,
        },
      ],
    ])('401 %s', async (_case, headers) => {
      await request(app.getHttpServer()).get(route).set(headers).expect(401);
      expect(internal.current.execute).not.toHaveBeenCalled();
    });
  });

  describe('2. API de integración (X-API-Key)', () => {
    it('la llave resuelve organización y permisos; el listado no recibe nada del request', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/integration/documents')
        .set('X-API-Key', fullKey.key)
        .expect(200);
      expect(integration.listOrganization.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKeyId: 'key-full',
          organizationId: ORG_ID,
        }),
        expect.anything(),
      );
    });

    it('?creatorEmail= va al listado por creador, también con READ_OWN', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/integration/documents?creatorEmail=ana@acme.mx')
        .set('X-API-Key', readOnlyKey.key)
        .expect(200);
      expect(integration.listUser.executeByEmail).toHaveBeenCalledWith(
        expect.objectContaining({ apiKeyId: 'key-read' }),
        'ana@acme.mx',
        expect.not.objectContaining({ creatorEmail: expect.anything() }),
      );
    });

    it.each([
      ['sin credenciales', {}],
      [
        'con el JWT de la plataforma',
        { Authorization: `Bearer ${platformJwt}` },
      ],
      [
        'con la cookie de una sesión pública de firma',
        {
          Cookie: `${PUBLIC_SIGNING_SESSION_COOKIE}=${sessionTokens.issue(sessionAccess as never, 'inv-1', 'EMAIL').token}`,
        },
      ],
    ])('401 %s', async (_case, headers) => {
      await request(app.getHttpServer())
        .get('/api/v1/integration/documents')
        .set(headers)
        .expect(401);
      expect(integration.listOrganization.execute).not.toHaveBeenCalled();
    });

    it('403 si la llave no tiene el permiso del endpoint (reenvío exige DOCUMENT.CREATE)', async () => {
      await request(app.getHttpServer())
        .post(
          `/api/v1/integration/documents/${DOC_ID}/collaborators/${COLLAB_ID}/resend-invitation`,
        )
        .set('X-API-Key', readOnlyKey.key)
        .expect(403);
      expect(integration.resend.execute).not.toHaveBeenCalled();
    });

    it('reenvía con la organización de la llave', async () => {
      await request(app.getHttpServer())
        .post(
          `/api/v1/integration/documents/${DOC_ID}/collaborators/${COLLAB_ID}/resend-invitation`,
        )
        .set('X-API-Key', fullKey.key)
        .set('User-Agent', 'erp/1.0')
        .expect(200);
      expect(integration.resend.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_ID,
          apiKeyId: 'key-full',
        }),
        DOC_ID,
        COLLAB_ID,
        expect.objectContaining({ userAgent: 'erp/1.0' }),
      );
    });

    it.each([
      ['organizationId en el query', '?organizationId=otra', {}],
      ['apiKeyId en el cuerpo', '', { apiKeyId: 'otra-llave' }],
      [
        'permissions en el cuerpo',
        '',
        { permissions: ['DOCUMENT.CREATE_ANY'] },
      ],
    ])('400 si el tercero manda %s', async (_case, query, body) => {
      await request(app.getHttpServer())
        .post(
          `/api/v1/integration/documents/${DOC_ID}/collaborators/${COLLAB_ID}/resend-invitation${query}`,
        )
        .set('X-API-Key', fullKey.key)
        .send(body)
        .expect(400);
      expect(integration.resend.execute).not.toHaveBeenCalled();
    });
  });

  describe('3. Firma pública (token de invitación → cookie de sesión)', () => {
    it('la invitación se consulta sin credenciales: sólo el token', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/public/signing-invitations/${INVITATION_TOKEN}`)
        .expect(200);
      expect(publicSigning.invitation.execute).toHaveBeenCalledWith(
        INVITATION_TOKEN,
      );
    });

    it('validar el código abre la sesión en una cookie HttpOnly, Secure y SameSite=Strict; el token no va en el cuerpo', async () => {
      const opened = await request(app.getHttpServer())
        .post(`/api/v1/public/signing-invitations/${INVITATION_TOKEN}/access`)
        .expect(200);
      const response = await request(app.getHttpServer())
        .post('/api/v1/public/signing-invitations/current/otp/verify')
        .set('Cookie', cookieFrom(opened, PUBLIC_SIGNING_INVITATION_COOKIE))
        .send({ code: '123456' })
        .expect(200);

      const cookie = (
        response.headers['set-cookie'] as unknown as string[]
      ).find((value) => value.startsWith(`${PUBLIC_SIGNING_SESSION_COOKIE}=`))!;
      expect(cookie).toMatch(new RegExp(`^${PUBLIC_SIGNING_SESSION_COOKIE}=`));
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(Object.keys(response.body)).toEqual(['expiresAt']);
    });

    it('sin la cookie de acceso a la invitación no se puede validar el código', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/public/signing-invitations/current/otp/verify')
        .send({ code: '123456' })
        .expect(401);
      expect(publicSigning.access.verifyCode).not.toHaveBeenCalled();
    });

    it('el portal del tercero termina en la MISMA sesión, con el canal THIRD_PARTY_PORTAL', async () => {
      const cookie = await openSessionCookie(
        `/api/v1/public/signing-launches/${LAUNCH_TOKEN}/access`,
      );

      expect(publicSigning.access.openWithLaunchToken).toHaveBeenCalledWith(
        LAUNCH_TOKEN,
      );
      expect(publicSigning.access.verifyCode).toHaveBeenCalledWith(
        expect.anything(),
        'THIRD_PARTY_PORTAL',
        '123456',
        expect.anything(),
      );
      await request(app.getHttpServer())
        .get('/api/v1/public/signing-sessions/current')
        .set('Cookie', cookie)
        .expect(200);
    });

    it('el acceso temporal se pide con X-API-Key y DOCUMENT.CREATE; el correo sólo localiza', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/integration/documents/${DOC_ID}/signing-access`)
        .set('X-API-Key', readOnlyKey.key)
        .send({ email: 'ana@correo.com' })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/api/v1/integration/documents/${DOC_ID}/signing-access`)
        .set('Authorization', `Bearer ${platformJwt}`)
        .send({ email: 'ana@correo.com' })
        .expect(401);
      expect(integration.signingAccess.execute).not.toHaveBeenCalled();

      await request(app.getHttpServer())
        .post(`/api/v1/integration/documents/${DOC_ID}/signing-access`)
        .set('X-API-Key', fullKey.key)
        .send({ email: 'ana@correo.com' })
        .expect(200);
      expect(integration.signingAccess.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_ID,
          apiKeyId: 'key-full',
        }),
        DOC_ID,
        'ana@correo.com',
        expect.anything(),
      );
    });

    it('con la cookie, la sesión opera sobre el colaborador de la invitación', async () => {
      const cookie = await openSessionCookie();

      await request(app.getHttpServer())
        .get('/api/v1/public/signing-sessions/current')
        .set('Cookie', cookie)
        .expect(200);

      const [session] = publicSigning.sessions.current.mock
        .calls[0] as unknown as [{ actor: Record<string, unknown> }];
      expect(session.actor).toEqual(
        expect.objectContaining({
          type: 'PUBLIC_INVITATION',
          collaboratorId: COLLAB_ID,
          userId: 'user-prov',
          sessionAccessId: 'session-1',
        }),
      );
    });

    it('firmar pasa el Idempotency-Key y nunca toma ids ni tipo del cuerpo', async () => {
      const cookie = await openSessionCookie();

      await request(app.getHttpServer())
        .post('/api/v1/public/signing-sessions/current/simple/sign')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'firma-1')
        .field('documentHash', 'a'.repeat(64))
        .field(
          'geolocation',
          JSON.stringify({ latitude: 19.4, longitude: -99.1 }),
        )
        .field('collaboratorId', 'otro-colaborador')
        .field('signatureType', 'FIEL')
        .expect(200);

      const [session, input] = publicSigning.sessions.signSimple.mock
        .calls[0] as unknown as [
        { actor: { collaboratorId: string } },
        { idempotencyKey: string },
      ];
      expect(session.actor.collaboratorId).toBe(COLLAB_ID);
      expect(input.idempotencyKey).toBe('firma-1');
      expect(JSON.stringify(input)).not.toContain('otro-colaborador');
    });

    it.each([
      ['sin credenciales', {}],
      [
        'con el JWT de la plataforma',
        { Authorization: `Bearer ${platformJwt}` },
      ],
      ['con una API key de organización', { 'X-API-Key': fullKey.key }],
      [
        'con el token de la invitación en lugar de la sesión',
        { Cookie: `${PUBLIC_SIGNING_SESSION_COOKIE}=${INVITATION_TOKEN}` },
      ],
    ])('401 %s', async (_case, headers) => {
      await request(app.getHttpServer())
        .get('/api/v1/public/signing-sessions/current')
        .set(headers)
        .expect(401);
      expect(publicSigning.sessions.current).not.toHaveBeenCalled();
    });
  });
});

import {
  BadRequestException,
  INestApplication,
  UnprocessableEntityException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import * as request from 'supertest';

import { applyGlobalApiPrefix } from './../src/common/constants/api-prefix.constants';
import { RequestIpInterceptor } from './../src/common/interceptors/request-ip.interceptor';
import { PublicSigningController } from './../src/document/public-signing.controller';
import { GetPublicSigningInvitationUseCase } from './../src/document/applications/get-public-signing-invitation.use-case';
import { SignDocumentUseCase } from './../src/document/applications/sign-document.use-case';
import { DocumentAuthorizationPolicy } from './../src/document/policies/document-authorization.policy';
import { DocumentService } from './../src/document/document.service';
import { VerificationCodeService } from './../src/document/verification-code.service';
import {
  GuestSigningAccessService,
  hashInvitationEmail,
} from './../src/document/services/guest-signing-access.service';
import { DocumentEntity } from './../src/document/entities/document.entity';
import { CollaboratorEntity } from './../src/document/entities/collaborator.entity';
import { GuestSigningAccessEntity } from './../src/document/entities/guest-signing-access.entity';
import { BiometricSignatureAttemptEntity } from './../src/biometric-signature/entities/biometric-signature-attempt.entity';
import { DOCUMENT_STATUS_ENUM } from './../src/document/enum/document-status.enum';
import { COLABORATOR_TYPE_ENUM } from './../src/document/enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from './../src/document/enum/collaborator-status.enum';
import { SIGNATURE_TYPE_ENUM } from './../src/document/enum/signature-type.enum';
import { SIGNING_AUTHORIZATION_ENUM } from './../src/document/enum/signing-authorization.enum';
import { VERIFICATION_EVENT_ENUM } from './../src/document/enum/verification-event.enum';
import { EmailService } from './../src/common/email/email.service';
import { AuditService } from './../src/audit/audit.service';
import { DocumentEventsProducer } from './../src/kafka/document-events.producer';
import { PublicGuestAdvancedSignatureController } from './../src/guest-advanced-signature/public-guest-advanced-signature.controller';
import { GuestAdvancedSignatureAccessUseCases } from './../src/guest-advanced-signature/applications/guest-advanced-signature-access.use-cases';
import { GuestAdvancedSignerService } from './../src/guest-advanced-signature/services/guest-advanced-signer.service';
import { GuestSigningTokenService } from './../src/guest-advanced-signature/guest/guest-signing-token.service';
import { GuestSigningAccessGuard } from './../src/guest-advanced-signature/guest/guest-signing-access.guard';

const DOCUMENT_ID = '7d1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const COLLABORATOR_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const INVITED_EMAIL = 'ana@correo.mx';
const ACCESS_CODE = '482913';
const DOCUMENT_HASH = 'b'.repeat(64);
const GEOLOCATION = { latitude: 19.4326, longitude: -99.1332, accuracy: 15 };
const GUEST_IP = '198.51.100.23';
const EFIRMA_PASSWORD = 'clave-correcta';

/** Resultado no sensible de `EfirmaService`: nunca incluye la llave ni la contraseña. */
const EFIRMA_RESULT = {
  originalHash: DOCUMENT_HASH,
  signatureBase64: 'firma-del-invitado-en-base64',
  algorithm: 'sha256',
  signedAt: new Date('2026-10-21T15:00:00.000Z'),
  certificate: {
    rfc: 'AAAA800101XXX',
    name: 'ANA LOPEZ',
    serialNumber: '00001000000700000001',
  },
};

/** Acceso de invitado en memoria: emitir, encontrar activo y consumir, como la tabla real. */
interface StoredAccess {
  id: string;
  documentId: string;
  collaboratorId: string;
  purpose: string;
  emailHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Integración HTTP de la "firma electrónica sin cuenta" (Firma Avanzada FIEL de un invitado), de
 * punta a punta por las rutas públicas:
 *
 * `GET invitation` → `POST access-code` → `POST access-code/verify` → `GET document` → `POST sign`.
 *
 * Son REALES los controladores, el `ValidationPipe` global, el interceptor de IP, el throttler, los
 * casos de uso, la resolución del invitado, el token y su guard, y `SignDocumentUseCase`. Se
 * sustituyen los bordes: la base (repositorios y accesos en memoria), el correo, la validación
 * criptográfica de la e.firma (exigiría un `.cer`/`.key` reales del SAT), el estampado y Kafka.
 *
 * El escenario con cuenta (`PATCH /document/:id/sign`) lo cubre `sign-fiel-seal.e2e-spec.ts`.
 */
describe('Firma electrónica sin cuenta: Firma Avanzada de invitado (e2e)', () => {
  let app: INestApplication;
  let document: Record<string, unknown>;
  let signer: Record<string, unknown>;
  let accesses: Map<string, StoredAccess>;
  let sentCodes: { to: string; code: string }[];
  let auditService: { create: jest.Mock };
  let documentService: Record<string, jest.Mock>;
  let collaboratorRepository: Record<string, unknown>;

  beforeEach(async () => {
    document = {
      id: DOCUMENT_ID,
      fileName: 'contrato.pdf',
      status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
      originalHash: DOCUMENT_HASH,
      isSequential: true,
      requiresVerification: false,
      completedSignersCount: 0,
      ipAddress: '10.0.0.1',
    };
    signer = {
      id: COLLABORATOR_ID,
      documentId: DOCUMENT_ID,
      colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      signatureType: SIGNATURE_TYPE_ENUM.FIEL,
      status: COLLABORATOR_STATUS_ENUM.PENDING,
      signingOrder: 1,
      accountId: null,
      account: null,
      email: INVITED_EMAIL,
    };
    accesses = new Map();
    sentCodes = [];
    auditService = { create: jest.fn() };

    // Transacción en memoria: lo que `claimWithGuestAccess` y la revocación escriben con el manager.
    const manager = {
      getRepository: (entity: unknown) => ({
        update: jest.fn(async (where: Record<string, unknown>, set: object) => {
          if (entity === CollaboratorEntity) {
            const claimable =
              where.id === signer.id &&
              signer.status === where.status &&
              !signer.accountId;
            if (claimable) Object.assign(signer, set);
            return { affected: claimable ? 1 : 0 };
          }
          return { affected: 0 };
        }),
      }),
    };

    collaboratorRepository = {
      findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.id === signer.id && where.documentId === signer.documentId
          ? signer
          : null,
      ),
      find: jest.fn(async () => [signer]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn(async (entity: object) => entity),
      manager: { transaction: jest.fn(async (work) => work(manager)) },
    };

    documentService = {
      findOne: jest.fn(async () => document),
      getDocumentMinioURL: jest.fn(async () => ({
        secureUrl: 'https://minio.local/contrato.pdf?firma',
        expiresIn: 300,
      })),
      // Sustituye a `EfirmaService`: exige los dos archivos y la contraseña correcta.
      validateAndSignWithEfirma: jest.fn(
        async (
          _document: unknown,
          input?: {
            password?: string;
            keyFile?: Express.Multer.File;
            cerFile?: Express.Multer.File;
          },
        ) => {
          if (!input?.keyFile || !input?.cerFile) {
            throw new BadRequestException(
              'Para firma avanzada se requieren los archivos .key y .cer',
            );
          }
          if (input.password !== EFIRMA_PASSWORD) {
            throw new UnprocessableEntityException(
              'La contraseña de la llave privada es incorrecta',
            );
          }
          return EFIRMA_RESULT;
        },
      ),
      finalizeSignedDocument: jest.fn(async () => {
        document.status = DOCUMENT_STATUS_ENUM.SIGNED;
      }),
      refreshPartiallySignedPreview: jest.fn(),
      notifyNextSigner: jest.fn(),
    };

    const verificationCodeService = {
      issue: jest.fn(async () => ({ code: ACCESS_CODE })),
      verifyAndConsume: jest.fn(
        async (_documentId: string, _signerId: string, code: string) => {
          if (code !== ACCESS_CODE) {
            throw new BadRequestException('El código no es válido');
          }
        },
      ),
      hasConsumedCode: jest.fn().mockResolvedValue(true),
    };

    const guestSigningAccessService = {
      issue: jest.fn(
        async (
          _manager: unknown,
          input: {
            documentId: string;
            collaboratorId: string;
            email: string;
            purpose: string;
            ttlSeconds: number;
          },
        ) => {
          const access: StoredAccess = {
            id: `0b0c0d0e-0000-4000-8000-00000000000${accesses.size + 1}`,
            documentId: input.documentId,
            collaboratorId: input.collaboratorId,
            purpose: input.purpose,
            emailHash: hashInvitationEmail(input.email),
            expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
            consumedAt: null,
            revokedAt: null,
          };
          accesses.set(access.id, access);
          return access as unknown as GuestSigningAccessEntity;
        },
      ),
      findActive: jest.fn(async (id: string) => {
        const access = accesses.get(id);
        return access && !access.consumedAt && !access.revokedAt
          ? access
          : null;
      }),
      consume: jest.fn(async (_manager: unknown, id: string) => {
        const access = accesses.get(id);
        if (!access || access.consumedAt || access.revokedAt) return false;
        access.consumedAt = new Date();
        return true;
      }),
      revokeOpenForCollaborator: jest.fn().mockResolvedValue(0),
      revokeOpenForDocument: jest.fn().mockResolvedValue(0),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60000, limit: 10 }] }),
      ],
      controllers: [
        PublicSigningController,
        PublicGuestAdvancedSignatureController,
      ],
      providers: [
        GetPublicSigningInvitationUseCase,
        GuestAdvancedSignatureAccessUseCases,
        GuestAdvancedSignerService,
        GuestSigningTokenService,
        GuestSigningAccessGuard,
        SignDocumentUseCase,
        { provide: APP_INTERCEPTOR, useClass: RequestIpInterceptor },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => ({ JWT_SECRET: 'secreto-e2e' })[key],
          },
        },
        {
          provide: getDataSourceToken(),
          useValue: { transaction: jest.fn(async (work) => work(manager)) },
        },
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: {
            findOne: jest.fn(async () => document),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
          },
        },
        {
          provide: getRepositoryToken(CollaboratorEntity),
          useValue: collaboratorRepository,
        },
        {
          provide: getRepositoryToken(BiometricSignatureAttemptEntity),
          useValue: { findOne: jest.fn() },
        },
        { provide: DocumentService, useValue: documentService },
        { provide: VerificationCodeService, useValue: verificationCodeService },
        {
          provide: GuestSigningAccessService,
          useValue: guestSigningAccessService,
        },
        {
          provide: EmailService,
          useValue: {
            sendVerificationCodeNotification: jest.fn(
              async (to: string, _fileName: string, code: string) => {
                sentCodes.push({ to, code });
              },
            ),
          },
        },
        { provide: AuditService, useValue: auditService },
        {
          provide: DocumentEventsProducer,
          useValue: {
            emitSigned: jest.fn(),
            emitCollaboratorSigned: jest.fn(),
          },
        },
        {
          provide: DocumentAuthorizationPolicy,
          useValue: { assertCanSign: jest.fn() },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    applyGlobalApiPrefix(app);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const base = `/api/v1/public/documents/${DOCUMENT_ID}`;

  /** Pide el código y lo canjea como lo hace la pantalla pública: sin correo, sólo el colaborador. */
  async function obtainGuestToken(): Promise<string> {
    await request(app.getHttpServer())
      .post(`${base}/advanced-signature/access-code`)
      .send({ collaboratorId: COLLABORATOR_ID })
      .expect(200);

    const verified = await request(app.getHttpServer())
      .post(`${base}/advanced-signature/access-code/verify`)
      .set('X-Forwarded-For', GUEST_IP)
      .send({ collaboratorId: COLLABORATOR_ID, code: ACCESS_CODE })
      .expect(200);

    return verified.body.accessToken as string;
  }

  function signAsGuest(token: string, password = EFIRMA_PASSWORD) {
    return request(app.getHttpServer())
      .post(`${base}/advanced-signature/sign`)
      .set('X-Guest-Signing-Token', token)
      .set('X-Forwarded-For', GUEST_IP)
      .field('password', password)
      .field('geolocation', JSON.stringify(GEOLOCATION))
      .field('documentHash', DOCUMENT_HASH)
      .attach('key', Buffer.from('contenido-key'), 'llave.key')
      .attach('cer', Buffer.from('contenido-cer'), 'certificado.cer');
  }

  it('un firmante FIEL sin cuenta completa la firma con código al correo y su e.firma', async () => {
    // 1. La invitación pública ofrece continuar sin cuenta.
    const invitation = await request(app.getHttpServer())
      .get(`${base}/invitation`)
      .query({ collaboratorId: COLLABORATOR_ID })
      .expect(200);
    expect(invitation.body).toEqual({
      documentName: 'contrato.pdf',
      maskedEmail: 'a***@correo.mx',
      signatureType: SIGNATURE_TYPE_ENUM.FIEL,
      availableForSigning: true,
      guestSigningAllowed: true,
    });

    // 2. El código sale al correo GUARDADO del colaborador, aunque la petición no trae correo.
    const token = await obtainGuestToken();
    expect(sentCodes).toEqual([{ to: INVITED_EMAIL, code: ACCESS_CODE }]);
    expect(token).toEqual(expect.any(String));

    // 3. Con el acceso ve el documento y el hash que va a firmar.
    const view = await request(app.getHttpServer())
      .get(`${base}/advanced-signature/document`)
      .set('X-Guest-Signing-Token', token)
      .expect(200);
    expect(view.body).toEqual(
      expect.objectContaining({ canSign: true, documentHash: DOCUMENT_HASH }),
    );

    // 4. Firma con su e.firma.
    const signed = await signAsGuest(token).expect(200);
    expect(signed.body).toEqual(
      expect.objectContaining({
        success: true,
        data: { id: DOCUMENT_ID, documentCompleted: true },
      }),
    );
    expect(document.status).toBe(DOCUMENT_STATUS_ENUM.SIGNED);
  });

  it('deja evidencia y trazabilidad: firmante, documento, fecha, IP, ubicación y método de validación', async () => {
    const token = await obtainGuestToken();
    await signAsGuest(token).expect(200);

    const saved = (collaboratorRepository.save as jest.Mock).mock.calls[0][0];
    expect(saved).toEqual(
      expect.objectContaining({
        id: COLLABORATOR_ID,
        status: COLLABORATOR_STATUS_ENUM.SIGNED,
        resolvedAt: expect.any(Date),
        ipAddress: GUEST_IP,
        geolocation: expect.objectContaining({ latitude: 19.4326 }),
        signingAuthorization: SIGNING_AUTHORIZATION_ENUM.GUEST_EMAIL_OTP,
        advancedSignature: EFIRMA_RESULT,
      }),
    );
    expect(JSON.stringify(saved)).not.toContain(EFIRMA_PASSWORD);

    expect(auditService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: DOCUMENT_ID,
        ipAddress: GUEST_IP,
        signedAt: expect.any(Date),
        users: [
          expect.objectContaining({
            userId: `guest-collaborator:${COLLABORATOR_ID}`,
          }),
        ],
        signatureType: SIGNATURE_TYPE_ENUM.FIEL,
        signingAuthorization: SIGNING_AUTHORIZATION_ENUM.GUEST_EMAIL_OTP,
      }),
    );
  });

  it('el acceso queda consumido: no sirve para firmar dos veces', async () => {
    const token = await obtainGuestToken();
    await signAsGuest(token).expect(200);

    await signAsGuest(token).expect(401);
  });

  it('un código incorrecto no emite acceso', async () => {
    await request(app.getHttpServer())
      .post(`${base}/advanced-signature/access-code`)
      .send({ collaboratorId: COLLABORATOR_ID })
      .expect(200);

    await request(app.getHttpServer())
      .post(`${base}/advanced-signature/access-code/verify`)
      .send({ collaboratorId: COLLABORATOR_ID, code: '000000' })
      .expect(400);
    expect(accesses.size).toBe(0);
  });

  it('sin token de invitado no se ve el documento ni se firma (401)', async () => {
    await request(app.getHttpServer())
      .get(`${base}/advanced-signature/document`)
      .expect(401);
    await request(app.getHttpServer())
      .post(`${base}/advanced-signature/sign`)
      .field('password', EFIRMA_PASSWORD)
      .expect(401);
  });

  it('una contraseña de e.firma incorrecta responde 422 y no gasta el acceso: puede reintentar', async () => {
    const token = await obtainGuestToken();

    const failed = await signAsGuest(token, 'otra-clave').expect(422);
    expect(failed.body.message).toBe(
      'La contraseña de la llave privada es incorrecta',
    );
    expect(signer.status).toBe(COLLABORATOR_STATUS_ENUM.PENDING);
    expect(auditService.create).not.toHaveBeenCalled();

    await signAsGuest(token).expect(200);
    expect(signer.status).toBe(COLLABORATOR_STATUS_ENUM.SIGNED);
  });

  it('si el documento cambió desde que lo revisó, rechaza la firma (400)', async () => {
    const token = await obtainGuestToken();
    document.originalHash = 'c'.repeat(64);

    const response = await signAsGuest(token).expect(400);
    expect(response.body.message).toBe(
      'El documento cambió desde que lo revisaste. Vuelve a abrirlo antes de firmar.',
    );
    expect(signer.status).toBe(COLLABORATOR_STATUS_ENUM.PENDING);
  });

  it('si el correo del enlace viene y no coincide, no envía código (403)', async () => {
    await request(app.getHttpServer())
      .post(`${base}/advanced-signature/access-code`)
      .send({ collaboratorId: COLLABORATOR_ID, email: 'otra@correo.mx' })
      .expect(403);
    expect(sentCodes).toEqual([]);
  });

  it('con una cuenta vinculada, la invitación no ofrece continuar sin cuenta y no envía código', async () => {
    signer.accountId = 'cuenta-vinculada';

    const invitation = await request(app.getHttpServer())
      .get(`${base}/invitation`)
      .query({ collaboratorId: COLLABORATOR_ID })
      .expect(200);
    expect(invitation.body.guestSigningAllowed).toBe(false);

    await request(app.getHttpServer())
      .post(`${base}/advanced-signature/access-code`)
      .send({ collaboratorId: COLLABORATOR_ID })
      .expect(403);
    expect(sentCodes).toEqual([]);
  });

  it('el código de acceso se emite con el evento de Firma Avanzada de invitado', async () => {
    await obtainGuestToken();

    const verificationCodes = app.get(VerificationCodeService) as unknown as {
      issue: jest.Mock;
    };
    expect(verificationCodes.issue).toHaveBeenCalledWith(
      DOCUMENT_ID,
      COLLABORATOR_ID,
      VERIFICATION_EVENT_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
      expect.any(String),
    );
  });
});

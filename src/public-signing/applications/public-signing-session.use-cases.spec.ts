import { BadRequestException, NotFoundException } from '@nestjs/common';

import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import {
  CertificateSubjectMismatchException,
  SIGNING_VALIDATION_ERROR_CODE_ENUM,
  SigningValidationException,
} from 'src/document/exceptions/signing-validation.exceptions';
import { CertificadoRevocadoException } from 'src/efirma/efirma.exceptions';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from 'src/identity-verification/enums/identity-verification-status.enum';
import { SigningRateLimitService } from 'src/signing-invitation/signing-rate-limit.service';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';

import { PublicSigningSessionContext } from '../interfaces/public-signing-session-context.interface';
import { PublicSignerIdentityService } from '../services/public-signer-identity.service';
import { SigningPolicyResolver } from '../services/signing-policy.resolver';
import { PublicSigningSessionUseCases } from './public-signing-session.use-cases';

const HASH = 'd'.repeat(64);
const PNG = {
  buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
} as Express.Multer.File;
const METADATA = { ipAddress: '10.0.0.5', userAgent: 'Mozilla/5.0' };

/** Verificación de Didit aprobada con el nombre que leyó de la identificación. */
function approvedVerification(fullName = 'ANA LOPEZ PEREZ') {
  return {
    id: 'iv-1',
    userId: 'user-prov',
    status: IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED,
    decision: { id_verifications: [{ full_name: fullName }] } as Record<
      string,
      unknown
    >,
    providerMetadata: {},
    completedAt: new Date('2026-10-27T10:00:00.000Z'),
    createdAt: new Date('2026-10-27T09:55:00.000Z'),
  };
}

/** Código estable de una promesa rechazada con `SigningValidationException`. */
async function rejectionCode(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SigningValidationException);
  return (error as SigningValidationException).code;
}

describe('PublicSigningSessionUseCases', () => {
  let session: PublicSigningSessionContext;
  let signers: unknown[];
  let latestVerification: ReturnType<typeof approvedVerification> | null;
  let documentService: { getDocumentMinioURL: jest.Mock };
  let signDocument: { sign: jest.Mock };
  let startDidit: { execute: jest.Mock };
  let uploadSignature: { execute: jest.Mock };
  let startBiometric: { executeForPublicSession: jest.Mock };
  let biometricStatus: { forPublicSession: jest.Mock };
  let audit: { create: jest.Mock };
  let verificationCodes: { hasConsumedCode: jest.Mock };
  let users: { exists: jest.Mock; update: jest.Mock };
  let useCases: PublicSigningSessionUseCases;

  const operations = () =>
    audit.create.mock.calls.map(([payload]) => payload.operation);

  beforeEach(() => {
    session = {
      actor: {
        type: 'PUBLIC_INVITATION',
        invitationId: 'inv-1',
        collaboratorId: 'c-1',
        userId: 'user-prov',
        accountId: 'acc-prov',
        organizationId: 'org-1',
        sessionAccessId: 'session-1',
        accessChannel: 'EMAIL',
        verifiedEmail: true,
      },
      document: {
        id: 'd-1',
        fileName: 'contrato.pdf',
        status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
        totalPages: 3,
        originalHash: HASH,
        isSequential: false,
      },
      collaborator: {
        id: 'c-1',
        status: COLLABORATOR_STATUS_ENUM.PENDING,
        signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
        signingOrder: 1,
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        email: 'ana@acme.mx',
        taxId: null,
        account: {
          user: {
            id: 'user-prov',
            email: 'ana@acme.mx',
            firstName: 'Ana',
            lastName: 'López',
            nationalId: null,
            lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
            signingCredentialStatus:
              SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING,
          },
        },
        simpleSignature: {
          signatureCoordinates: [
            {
              page: 2,
              xRatio: 0.1,
              yRatio: 0.7,
              widthRatio: 0.3,
              heightRatio: 0.1,
            },
          ],
        },
      },
      expiresAt: new Date('2026-10-27T12:30:00.000Z'),
    } as unknown as PublicSigningSessionContext;
    signers = [session.collaborator];
    latestVerification = approvedVerification();

    documentService = {
      getDocumentMinioURL: jest.fn(async () => ({
        secureUrl: 'https://minio/firmado',
        expiresIn: 300,
      })),
    };
    signDocument = {
      sign: jest.fn(async () => ({
        success: true,
        message: 'ok',
        data: { id: 'd-1', documentCompleted: false },
      })),
    };
    startDidit = {
      execute: jest.fn(async () => ({
        verificationId: 'iv-2',
        url: 'https://didit',
      })),
    };
    uploadSignature = {
      execute: jest.fn(async () => ({ data: { id: 's-1' } })),
    };
    startBiometric = {
      executeForPublicSession: jest.fn(async () => ({ status: 'PENDING' })),
    };
    biometricStatus = { forPublicSession: jest.fn(async () => null) };
    audit = { create: jest.fn() };
    verificationCodes = { hasConsumedCode: jest.fn(async () => true) };
    users = {
      exists: jest.fn(async () => false),
      update: jest.fn(async () => ({})),
    };

    const store = new Map<string, string>();
    const redis = {
      setIfAbsent: jest.fn(async (k: string, v: string) =>
        store.has(k) ? false : (store.set(k, v), true),
      ),
      set: jest.fn(async (k: string, v: string) => store.set(k, v)),
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      del: jest.fn(async (k: string) => store.delete(k)),
      incrementWithExpiry: jest.fn(async (k: string) => {
        const next = Number(store.get(k) ?? 0) + 1;
        store.set(k, String(next));
        return next;
      }),
    };
    const { SigningIdempotencyService } = jest.requireActual(
      '../services/signing-idempotency.service',
    );
    const identity = new PublicSignerIdentityService(
      {
        findOne: jest.fn(async () => latestVerification),
      } as never,
      users as never,
    );

    useCases = new PublicSigningSessionUseCases(
      { find: jest.fn(async () => signers) } as never,
      documentService as never,
      signDocument as never,
      startDidit as never,
      uploadSignature as never,
      startBiometric as never,
      new SigningIdempotencyService(redis),
      biometricStatus as never,
      audit as never,
      new SigningPolicyResolver(),
      identity,
      verificationCodes as never,
      new SigningRateLimitService(redis as never),
    );
  });

  it('una firma se audita al iniciarla; si falla, también el fallo (con el actor y sin datos sensibles)', async () => {
    signDocument.sign.mockRejectedValueOnce(new BadRequestException('no'));
    session.collaborator.account!.user.signingCredentialStatus =
      SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED;

    await expect(
      useCases.signSimple(
        session,
        { documentHash: HASH, idempotencyKey: 'k-f', metadata: METADATA },
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(operations()).toEqual([
      'SIGNING_STARTED',
      'IDENTITY_VERIFICATION_CHECKED',
      'SIGNING_FAILED',
    ]);
    expect(audit.create.mock.calls[2][0]).toEqual(
      expect.objectContaining({
        result: 'FAILURE',
        actor: expect.objectContaining({
          type: 'PUBLIC_INVITATION',
          collaboratorId: 'c-1',
          accessChannel: 'EMAIL',
        }),
      }),
    );
  });

  it('biometricStatus: el último intento del colaborador de la sesión', async () => {
    session.collaborator.signatureType = SIGNATURE_TYPE_ENUM.BIOMETRIC;
    await useCases.biometricStatus(session);
    expect(biometricStatus.forPublicSession).toHaveBeenCalledWith('d-1', 'c-1');
  });

  describe('current', () => {
    it('firma simple con identidad aprobada: READY_TO_SIGN con los requisitos de la política', async () => {
      await expect(useCases.current(session)).resolves.toEqual({
        status: 'READY_TO_SIGN',
        document: {
          name: 'contrato.pdf',
          status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
          totalPages: 3,
          documentHash: HASH,
        },
        signer: {
          name: 'Ana López',
          emailMasked: 'a***@acme.mx',
          maskedEmail: 'a***@acme.mx',
          isProvisional: true,
          status: COLLABORATOR_STATUS_ENUM.PENDING,
          canSign: true,
          accountStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
        },
        signature: {
          type: 'SIMPLE',
          requiresEmailVerification: true,
          requiresIdentityValidation: true,
          identityProvider: 'DIDIT',
          requiresCertificateValidation: false,
          certificateRequirements: null,
          emailVerified: true,
          credentialStatus: SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING,
          identityVerification: {
            status: 'APPROVED',
            verificationId: 'iv-1',
            dataMatches: true,
            resumeUrl: null,
            satisfied: true,
            errorCode: null,
          },
        },
        positions: [
          {
            page: 2,
            xRatio: 0.1,
            yRatio: 0.7,
            widthRatio: 0.3,
            heightRatio: 0.1,
          },
        ],
        session: { expiresAt: '2026-10-27T12:30:00.000Z' },
      });
    });

    it('firma simple sin verificación: IDENTITY_VERIFICATION_REQUIRED', async () => {
      latestVerification = null;
      const current = await useCases.current(session);
      expect(current.status).toBe('IDENTITY_VERIFICATION_REQUIRED');
      expect(current.signature.identityVerification?.status).toBe(
        'NOT_STARTED',
      );
    });

    it('firma simple rechazada por Didit: IDENTITY_VERIFICATION_REJECTED', async () => {
      latestVerification = {
        ...approvedVerification(),
        status: IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED,
      };
      await expect(useCases.current(session)).resolves.toEqual(
        expect.objectContaining({ status: 'IDENTITY_VERIFICATION_REJECTED' }),
      );
    });

    it('firma simple aprobada con otra persona: IDENTITY_DATA_MISMATCH', async () => {
      latestVerification = approvedVerification('LUIS MARTINEZ');
      await expect(useCases.current(session)).resolves.toEqual(
        expect.objectContaining({ status: 'IDENTITY_DATA_MISMATCH' }),
      );
    });

    it('firma avanzada: ADVANCED con validación de certificado y sin Didit', async () => {
      session.collaborator.signatureType = SIGNATURE_TYPE_ENUM.FIEL;
      const current = await useCases.current(session);

      expect(current.status).toBe('READY_TO_SIGN');
      expect(current.signature).toEqual(
        expect.objectContaining({
          type: 'ADVANCED',
          requiresIdentityValidation: false,
          identityProvider: null,
          requiresCertificateValidation: true,
          certificateRequirements: {
            validateValidity: true,
            validateRevocation: true,
            validateSubjectMatch: true,
          },
          identityVerification: null,
        }),
      );
    });

    it('secuencial y no es su turno: SIGNING_NOT_AVAILABLE', async () => {
      session.document.isSequential = true;
      signers = [
        {
          id: 'c-0',
          status: COLLABORATOR_STATUS_ENUM.PENDING,
          signingOrder: 0,
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
        session.collaborator,
      ];
      const current = await useCases.current(session);
      expect(current.status).toBe('SIGNING_NOT_AVAILABLE');
      expect(current.signer.canSign).toBe(false);
    });

    it('ya firmó: SIGNED', async () => {
      session.collaborator.status = COLLABORATOR_STATUS_ENUM.SIGNED;
      await expect(useCases.current(session)).resolves.toEqual(
        expect.objectContaining({ status: 'SIGNED' }),
      );
    });
  });

  it('document: URL temporal del documento de la sesión', async () => {
    await expect(useCases.document(session)).resolves.toEqual({
      fileUrl: 'https://minio/firmado',
      expiresIn: 300,
      documentHash: HASH,
    });
    expect(documentService.getDocumentMinioURL).toHaveBeenCalledWith('d-1');
  });

  it('document: no expone un documento que todavía no sale a firma', async () => {
    session.document.status = DOCUMENT_STATUS_ENUM.PENDING_APPROVAL;
    await expect(useCases.document(session)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(documentService.getDocumentMinioURL).not.toHaveBeenCalled();
  });

  describe('verificación de identidad', () => {
    it('startIdentityVerification: abre Didit sobre el usuario provisional y lo audita', async () => {
      await useCases.startIdentityVerification(
        session,
        { returnPath: '/sign/session' },
        METADATA,
      );

      expect(startDidit.execute).toHaveBeenCalledWith('user-prov', {
        returnPath: '/sign/session',
      });
      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'IDENTITY_VERIFICATION_STARTED',
          result: 'SUCCESS',
          evidence: {
            identityProvider: 'DIDIT',
            identityVerificationId: 'iv-2',
          },
        }),
      );
    });

    it('startIdentityVerification: rechaza a un firmante que no es de firma simple', async () => {
      session.collaborator.signatureType = SIGNATURE_TYPE_ENUM.FIEL;
      await expect(
        useCases.startIdentityVerification(session, {}, METADATA),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('startIdentityVerification: limita los inicios por firmante', async () => {
      for (let i = 0; i < 5; i += 1) {
        await useCases.startIdentityVerification(session, {}, METADATA);
      }
      await expect(
        useCases.startIdentityVerification(session, {}, METADATA),
      ).rejects.toMatchObject({ status: 429 });
      expect(startDidit.execute).toHaveBeenCalledTimes(5);
    });

    it('identityVerification: estado pendiente con la URL para retomar', async () => {
      latestVerification = {
        ...approvedVerification(),
        status: IDENTITY_VERIFICATION_STATUS_ENUM.IN_PROGRESS,
        providerMetadata: { hostedUrl: 'https://verify.didit.me/s/1' },
      } as never;

      await expect(useCases.identityVerification(session)).resolves.toEqual(
        expect.objectContaining({
          status: 'IN_PROGRESS',
          resumeUrl: 'https://verify.didit.me/s/1',
          satisfied: false,
        }),
      );
    });
  });

  describe('signSimple', () => {
    it('identidad aprobada: registra la rúbrica del provisional y firma con el actor de la sesión', async () => {
      await useCases.signSimple(
        session,
        {
          documentHash: HASH,
          geolocation: { latitude: 1, longitude: 2 } as never,
          idempotencyKey: 'k-1',
          metadata: METADATA,
        },
        PNG,
      );

      expect(uploadSignature.execute).toHaveBeenCalledWith(
        'user-prov',
        { signatureImage: PNG },
        { signatureImage: [PNG] },
      );
      expect(signDocument.sign).toHaveBeenCalledWith(
        session.actor,
        expect.objectContaining({
          documentId: 'd-1',
          documentHash: HASH,
          metadata: METADATA,
        }),
        SIGNATURE_TYPE_ENUM.SIMPLE,
      );
      expect(uploadSignature.execute.mock.invocationCallOrder[0]).toBeLessThan(
        signDocument.sign.mock.invocationCallOrder[0],
      );
      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'IDENTITY_VERIFICATION_CHECKED',
          result: 'SUCCESS',
          evidence: {
            identityProvider: 'DIDIT',
            identityVerificationId: 'iv-1',
          },
        }),
      );
    });

    it('identidad aprobada con CURP: la guarda en el usuario provisional', async () => {
      latestVerification = {
        ...approvedVerification(),
        decision: {
          id_verifications: [
            {
              full_name: 'ANA LOPEZ PEREZ',
              personal_number: 'LOPA800101MDFPRN09',
            },
          ],
        },
      };
      await useCases.signSimple(
        session,
        { documentHash: HASH, idempotencyKey: 'k-curp', metadata: METADATA },
        PNG,
      );
      expect(users.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-prov' }),
        { nationalId: 'LOPA800101MDFPRN09' },
      );
    });

    it('identidad rechazada: IDENTITY_VERIFICATION_REJECTED y no firma', async () => {
      latestVerification = {
        ...approvedVerification(),
        status: IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED,
      };
      await expect(
        rejectionCode(
          useCases.signSimple(
            session,
            { documentHash: HASH, idempotencyKey: 'k-r', metadata: METADATA },
            PNG,
          ),
        ),
      ).resolves.toBe(
        SIGNING_VALIDATION_ERROR_CODE_ENUM.IDENTITY_VERIFICATION_REJECTED,
      );
      expect(signDocument.sign).not.toHaveBeenCalled();
      expect(uploadSignature.execute).not.toHaveBeenCalled();
      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'IDENTITY_VERIFICATION_CHECKED',
          result: 'FAILURE',
          evidence: {
            identityProvider: 'DIDIT',
            errorCode: 'IDENTITY_VERIFICATION_REJECTED',
          },
        }),
      );
    });

    it('identidad pendiente: IDENTITY_VERIFICATION_REQUIRED', async () => {
      latestVerification = {
        ...approvedVerification(),
        status: IDENTITY_VERIFICATION_STATUS_ENUM.PENDING,
      };
      await expect(
        rejectionCode(
          useCases.signSimple(
            session,
            { documentHash: HASH, idempotencyKey: 'k-p', metadata: METADATA },
            PNG,
          ),
        ),
      ).resolves.toBe(
        SIGNING_VALIDATION_ERROR_CODE_ENUM.IDENTITY_VERIFICATION_REQUIRED,
      );
    });

    it('datos de Didit de otra persona: IDENTITY_DATA_MISMATCH', async () => {
      latestVerification = approvedVerification('LUIS MARTINEZ');
      await expect(
        rejectionCode(
          useCases.signSimple(
            session,
            { documentHash: HASH, idempotencyKey: 'k-m', metadata: METADATA },
            PNG,
          ),
        ),
      ).resolves.toBe(
        SIGNING_VALIDATION_ERROR_CODE_ENUM.IDENTITY_DATA_MISMATCH,
      );
      expect(signDocument.sign).not.toHaveBeenCalled();
    });

    it('sin el código del correo consumido: EMAIL_VERIFICATION_REQUIRED', async () => {
      verificationCodes.hasConsumedCode.mockResolvedValueOnce(false);
      await expect(
        rejectionCode(
          useCases.signSimple(
            session,
            { documentHash: HASH, idempotencyKey: 'k-e', metadata: METADATA },
            PNG,
          ),
        ),
      ).resolves.toBe(
        SIGNING_VALIDATION_ERROR_CODE_ENUM.EMAIL_VERIFICATION_REQUIRED,
      );
    });

    it('secuencial y no es su turno: SIGNING_NOT_AVAILABLE', async () => {
      session.document.isSequential = true;
      signers = [
        {
          id: 'c-0',
          status: COLLABORATOR_STATUS_ENUM.PENDING,
          signingOrder: 0,
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
        session.collaborator,
      ];
      await expect(
        rejectionCode(
          useCases.signSimple(
            session,
            { documentHash: HASH, idempotencyKey: 'k-t', metadata: METADATA },
            PNG,
          ),
        ),
      ).resolves.toBe(SIGNING_VALIDATION_ERROR_CODE_ENUM.SIGNING_NOT_AVAILABLE);
      expect(signDocument.sign).not.toHaveBeenCalled();
    });

    it('secuencial y el anterior ya firmó: firma', async () => {
      session.document.isSequential = true;
      signers = [
        {
          id: 'c-0',
          status: COLLABORATOR_STATUS_ENUM.SIGNED,
          signingOrder: 0,
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
        session.collaborator,
      ];
      await useCases.signSimple(
        session,
        { documentHash: HASH, idempotencyKey: 'k-s', metadata: METADATA },
        PNG,
      );
      expect(signDocument.sign).toHaveBeenCalled();
    });

    it('documento ya no espera firmas: SIGNING_NOT_AVAILABLE', async () => {
      session.document.status = DOCUMENT_STATUS_ENUM.CANCELLED;
      await expect(
        rejectionCode(
          useCases.signSimple(
            session,
            { documentHash: HASH, idempotencyKey: 'k-c', metadata: METADATA },
            PNG,
          ),
        ),
      ).resolves.toBe(SIGNING_VALIDATION_ERROR_CODE_ENUM.SIGNING_NOT_AVAILABLE);
    });

    it('sin rúbrica registrada exige la imagen PNG', async () => {
      await expect(
        useCases.signSimple(
          session,
          { documentHash: HASH, idempotencyKey: 'k-1', metadata: METADATA },
          { buffer: Buffer.from('no-es-png') } as Express.Multer.File,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(signDocument.sign).not.toHaveBeenCalled();
    });

    it('con la credencial ya completa usa la rúbrica que tiene', async () => {
      session.collaborator.account!.user.signingCredentialStatus =
        SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED;
      await useCases.signSimple(
        session,
        { documentHash: HASH, idempotencyKey: 'k-1', metadata: METADATA },
        undefined,
      );
      expect(uploadSignature.execute).not.toHaveBeenCalled();
      expect(signDocument.sign).toHaveBeenCalled();
    });

    it('un reintento con la misma clave devuelve la misma respuesta sin volver a firmar', async () => {
      const input = {
        documentHash: HASH,
        idempotencyKey: 'k-1',
        metadata: METADATA,
      };
      const first = await useCases.signSimple(session, input, PNG);
      const replay = await useCases.signSimple(session, input, PNG);

      expect(replay).toEqual(first);
      expect(signDocument.sign).toHaveBeenCalledTimes(1);
    });
  });

  it('las firmas exigen Idempotency-Key', () => {
    expect(() =>
      useCases.signAdvanced(
        session,
        { documentHash: HASH, idempotencyKey: undefined, metadata: METADATA },
        {},
      ),
    ).toThrow(BadRequestException);
  });

  describe('signAdvanced', () => {
    const keyFile = { buffer: Buffer.from('key') } as Express.Multer.File;
    const cerFile = { buffer: Buffer.from('cer') } as Express.Multer.File;

    beforeEach(() => {
      session.collaborator.signatureType = SIGNATURE_TYPE_ENUM.FIEL;
    });

    it('certificado válido: delega la e.firma con el titular esperado y sin Didit', async () => {
      session.collaborator.taxId = 'LOPA800101AB1';

      await useCases.signAdvanced(
        session,
        { documentHash: HASH, idempotencyKey: 'k-2', metadata: METADATA },
        { keyFile, cerFile, password: 'secreta' },
      );

      expect(signDocument.sign).toHaveBeenCalledWith(
        session.actor,
        expect.objectContaining({
          advancedSignatureInput: { keyFile, cerFile, password: 'secreta' },
          expectedCertificateSubject: {
            taxId: 'LOPA800101AB1',
            fullName: 'Ana López',
          },
        }),
        SIGNATURE_TYPE_ENUM.FIEL,
      );
      expect(operations()).not.toContain('IDENTITY_VERIFICATION_CHECKED');
    });

    it('certificado revocado: audita CERTIFICATE_VALIDATION_FAILED y propaga el error', async () => {
      signDocument.sign.mockRejectedValueOnce(
        new CertificadoRevocadoException(),
      );

      await expect(
        useCases.signAdvanced(
          session,
          { documentHash: HASH, idempotencyKey: 'k-3', metadata: METADATA },
          { keyFile, cerFile, password: 'secreta' },
        ),
      ).rejects.toBeInstanceOf(CertificadoRevocadoException);

      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'CERTIFICATE_VALIDATION_FAILED',
          result: 'FAILURE',
          evidence: { errorCode: 'CERTIFICATE_REVOKED', documentHash: HASH },
        }),
      );
      const serialized = JSON.stringify(audit.create.mock.calls);
      expect(serialized).not.toContain('secreta');
    });

    it('titular distinto: CERTIFICATE_SUBJECT_MISMATCH auditado', async () => {
      signDocument.sign.mockRejectedValueOnce(
        new CertificateSubjectMismatchException(),
      );

      await expect(
        rejectionCode(
          useCases.signAdvanced(
            session,
            { documentHash: HASH, idempotencyKey: 'k-4', metadata: METADATA },
            { keyFile, cerFile, password: 'secreta' },
          ),
        ),
      ).resolves.toBe(
        SIGNING_VALIDATION_ERROR_CODE_ENUM.CERTIFICATE_SUBJECT_MISMATCH,
      );
      expect(operations()).toContain('CERTIFICATE_VALIDATION_FAILED');
    });

    it('un error que no es del certificado no se audita como tal', async () => {
      signDocument.sign.mockRejectedValueOnce(new BadRequestException('PDF'));
      await expect(
        useCases.signAdvanced(
          session,
          { documentHash: HASH, idempotencyKey: 'k-5', metadata: METADATA },
          { keyFile, cerFile, password: 'secreta' },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(operations()).not.toContain('CERTIFICATE_VALIDATION_FAILED');
    });

    it('limita los intentos con certificado por firmante', async () => {
      signDocument.sign.mockRejectedValue(new CertificadoRevocadoException());
      for (let i = 0; i < 10; i += 1) {
        await expect(
          useCases.signAdvanced(
            session,
            {
              documentHash: HASH,
              idempotencyKey: `k-l${i}`,
              metadata: METADATA,
            },
            { keyFile, cerFile, password: 'secreta' },
          ),
        ).rejects.toBeInstanceOf(CertificadoRevocadoException);
      }
      await expect(
        useCases.signAdvanced(
          session,
          { documentHash: HASH, idempotencyKey: 'k-l10', metadata: METADATA },
          { keyFile, cerFile, password: 'secreta' },
        ),
      ).rejects.toMatchObject({ status: 429 });
      expect(signDocument.sign).toHaveBeenCalledTimes(10);
    });

    it('rechaza a un firmante que no es FIEL', async () => {
      session.collaborator.signatureType = SIGNATURE_TYPE_ENUM.SIMPLE;
      await expect(
        useCases.signAdvanced(
          session,
          { documentHash: HASH, idempotencyKey: 'k-6', metadata: METADATA },
          { keyFile, cerFile, password: 'secreta' },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(signDocument.sign).not.toHaveBeenCalled();
    });
  });

  it('signBiometric: abre la sesión de Didit del colaborador de la invitación', async () => {
    session.collaborator.signatureType = SIGNATURE_TYPE_ENUM.BIOMETRIC;
    const dto = {
      geolocation: { latitude: 1, longitude: 2 },
      biometricConsent: true,
    } as never;

    await useCases.signBiometric(session, dto, 'k-3', METADATA);

    expect(startBiometric.executeForPublicSession).toHaveBeenCalledWith(
      'd-1',
      'c-1',
      dto,
      '10.0.0.5',
    );
  });

  it('signBiometric: rechaza a un firmante que no es biométrico', async () => {
    await expect(
      useCases.signBiometric(session, {} as never, 'k-4', METADATA),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(startBiometric.executeForPublicSession).not.toHaveBeenCalled();
  });
});

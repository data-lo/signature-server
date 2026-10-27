import { BadRequestException, NotFoundException } from '@nestjs/common';

import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';

import { PublicSigningSessionContext } from '../interfaces/public-signing-session-context.interface';
import { PublicSigningSessionUseCases } from './public-signing-session.use-cases';

const HASH = 'd'.repeat(64);
const PNG = {
  buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
} as Express.Multer.File;
const METADATA = { ipAddress: '10.0.0.5', userAgent: 'Mozilla/5.0' };

describe('PublicSigningSessionUseCases', () => {
  let session: PublicSigningSessionContext;
  let documentService: { getDocumentMinioURL: jest.Mock };
  let signDocument: { sign: jest.Mock };
  let startDidit: { execute: jest.Mock };
  let uploadSignature: { execute: jest.Mock };
  let startBiometric: { executeForPublicSession: jest.Mock };
  let useCases: PublicSigningSessionUseCases;

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
        email: 'ana@acme.mx',
        account: {
          user: {
            email: 'ana@acme.mx',
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
    startDidit = { execute: jest.fn(async () => ({ url: 'https://didit' })) };
    uploadSignature = {
      execute: jest.fn(async () => ({ data: { id: 's-1' } })),
    };
    startBiometric = {
      executeForPublicSession: jest.fn(async () => ({ status: 'PENDING' })),
    };

    const store = new Map<string, string>();
    const redis = {
      setIfAbsent: jest.fn(async (k: string, v: string) =>
        store.has(k) ? false : (store.set(k, v), true),
      ),
      set: jest.fn(async (k: string, v: string) => store.set(k, v)),
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      del: jest.fn(async (k: string) => store.delete(k)),
    };
    const { SigningIdempotencyService } = jest.requireActual(
      '../services/signing-idempotency.service',
    );

    useCases = new PublicSigningSessionUseCases(
      { find: jest.fn(async () => [session.collaborator]) } as never,
      documentService as never,
      signDocument as never,
      startDidit as never,
      uploadSignature as never,
      startBiometric as never,
      new SigningIdempotencyService(redis),
    );
  });

  it('current: contexto completo con posiciones y credencial de la firma simple', async () => {
    await expect(useCases.current(session)).resolves.toEqual({
      document: {
        name: 'contrato.pdf',
        status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
        totalPages: 3,
        documentHash: HASH,
      },
      signer: {
        maskedEmail: 'a***@acme.mx',
        status: COLLABORATOR_STATUS_ENUM.PENDING,
        canSign: true,
        accountStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
      },
      signature: {
        type: SIGNATURE_TYPE_ENUM.SIMPLE,
        emailVerified: true,
        requiresIdentityValidation: true,
        credentialStatus: SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING,
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

  it('verifyIdentity: abre Didit sobre el usuario provisional', async () => {
    await useCases.verifyIdentity(session, { returnPath: '/sign/session' });
    expect(startDidit.execute).toHaveBeenCalledWith('user-prov', {
      returnPath: '/sign/session',
    });
  });

  it('verifyIdentity: rechaza a un firmante que no es de firma simple', () => {
    session.collaborator.signatureType = SIGNATURE_TYPE_ENUM.FIEL;
    expect(() => useCases.verifyIdentity(session, {})).toThrow(
      BadRequestException,
    );
  });

  it('signSimple: registra la rúbrica del provisional y firma con el actor de la sesión', async () => {
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
  });

  it('signSimple: sin rúbrica registrada exige la imagen PNG', async () => {
    await expect(
      useCases.signSimple(
        session,
        { documentHash: HASH, idempotencyKey: 'k-1', metadata: METADATA },
        { buffer: Buffer.from('no-es-png') } as Express.Multer.File,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(signDocument.sign).not.toHaveBeenCalled();
  });

  it('signSimple: con la credencial ya completa usa la rúbrica que tiene', async () => {
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

  it('signSimple: un reintento con la misma clave devuelve la misma respuesta sin volver a firmar', async () => {
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

  it('las firmas exigen Idempotency-Key', () => {
    expect(() =>
      useCases.signAdvanced(
        session,
        { documentHash: HASH, idempotencyKey: undefined, metadata: METADATA },
        {},
      ),
    ).toThrow(BadRequestException);
  });

  it('signAdvanced: delega la e.firma con el tipo FIEL', async () => {
    session.collaborator.signatureType = SIGNATURE_TYPE_ENUM.FIEL;
    const keyFile = { buffer: Buffer.from('key') } as Express.Multer.File;
    const cerFile = { buffer: Buffer.from('cer') } as Express.Multer.File;

    await useCases.signAdvanced(
      session,
      { documentHash: HASH, idempotencyKey: 'k-2', metadata: METADATA },
      { keyFile, cerFile, password: 'secreta' },
    );

    expect(signDocument.sign).toHaveBeenCalledWith(
      session.actor,
      expect.objectContaining({
        advancedSignatureInput: { keyFile, cerFile, password: 'secreta' },
      }),
      SIGNATURE_TYPE_ENUM.FIEL,
    );
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

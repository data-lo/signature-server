import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { DiditConfigurationException } from 'src/identity-verification/exceptions/identity-verification.exceptions';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../../enum/collaborator-status.enum';
import { COLABORATOR_TYPE_ENUM } from '../../enum/colaborator-type.enum';
import { BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM } from '../enums/biometric-signature-attempt-status.enum';
import { BiometricSignatureAttemptService } from '../services/biometric-signature-attempt.service';
import { StartBiometricSignatureUseCase } from './start-biometric-signature.use-case';

const DOCUMENT_ID = 'doc-1';
const USER_ID = 'user-1';
const HASH = 'hash-original';
const GEO = { latitude: 19.43, longitude: -99.13 };
const AUTHORIZATION = {
  userId: USER_ID,
  scopes: [PERMISSION_SCOPE_ENUM.SELF],
} as unknown as AuthorizationContext;

function signer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'col-1',
    colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
    status: COLLABORATOR_STATUS_ENUM.PENDING,
    signatureType: SIGNATURE_TYPE_ENUM.BIOMETRIC,
    signingOrder: 1,
    account: { userId: USER_ID },
    ...overrides,
  };
}

function uniqueViolation() {
  const error = new QueryFailedError('INSERT', [], new Error('duplicate'));
  (error as unknown as { driverError: { code: string } }).driverError = {
    code: '23505',
  };
  return error;
}

describe('StartBiometricSignatureUseCase', () => {
  let attemptRepository: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    findOne: jest.Mock;
    findOneByOrFail: jest.Mock;
  };
  let documentService: {
    findOne: jest.Mock;
    findOrLinkMySignerCollaborator: jest.Mock;
  };
  let verificationCodeService: { hasConsumedCode: jest.Mock };
  let didit: { createSession: jest.Mock };
  let config: { get: jest.Mock };
  let useCase: StartBiometricSignatureUseCase;
  let document: Record<string, unknown>;
  let me: ReturnType<typeof signer>;
  /** Filas guardadas, para que `findOneByOrFail` devuelva lo que se escribió. */
  let stored: Record<string, Record<string, unknown>>;

  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://app.ejemplo.com';
    document = {
      id: DOCUMENT_ID,
      status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
      originalHash: HASH,
      isSequential: true,
      requiresVerification: false,
    };
    me = signer();
    stored = {};

    attemptRepository = {
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn(async (data) => {
        stored['attempt-1'] = { ...data, id: 'attempt-1' };
        return stored['attempt-1'];
      }),
      update: jest.fn(async (criteria, data) => {
        const id = typeof criteria === 'string' ? criteria : criteria.id;
        stored[id] = { ...(stored[id] ?? {}), ...data };
      }),
      findOne: jest.fn().mockResolvedValue(null),
      findOneByOrFail: jest.fn(async ({ id }) => stored[id]),
    };
    documentService = {
      findOne: jest.fn(async () => document),
      findOrLinkMySignerCollaborator: jest.fn(async () => ({
        signerCollaborators: [me],
        myParticipant: me,
      })),
    };
    verificationCodeService = {
      hasConsumedCode: jest.fn().mockResolvedValue(true),
    };
    didit = {
      createSession: jest.fn().mockResolvedValue({
        sessionId: 'didit-ses-1',
        url: 'https://verify.didit.me/session/abc',
        workflowId: 'wf-bio',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        raw: { session_id: 'didit-ses-1' },
      }),
    };
    config = { get: jest.fn().mockReturnValue('wf-bio') };

    useCase = new StartBiometricSignatureUseCase(
      attemptRepository as never,
      new BiometricSignatureAttemptService(attemptRepository as never),
      documentService as never,
      verificationCodeService as never,
      {
        assertCanSign: jest.fn(),
      } as never,
      didit as never,
      config as never,
    );
  });

  it('persiste el intento ANTES de llamar a Didit y le guarda la sesión', async () => {
    const order: string[] = [];
    attemptRepository.save.mockImplementation(async (data) => {
      order.push('save');
      stored['attempt-1'] = { ...data, id: 'attempt-1' };
      return stored['attempt-1'];
    });
    didit.createSession.mockImplementation(async () => {
      order.push('didit');
      return {
        sessionId: 'didit-ses-1',
        url: 'https://verify.didit.me/session/abc',
        workflowId: 'wf-bio',
        expiresAt: null,
        raw: {},
      };
    });

    const session = await useCase.execute(
      DOCUMENT_ID,
      USER_ID,
      GEO,
      AUTHORIZATION,
    );

    expect(order).toEqual(['save', 'didit']);
    expect(attemptRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: DOCUMENT_ID,
        collaboratorId: 'col-1',
        userId: USER_ID,
        documentHash: HASH,
        status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING,
        geolocation: GEO,
      }),
    );
    expect(didit.createSession).toHaveBeenCalledWith(
      USER_ID,
      `https://app.ejemplo.com/dashboard/documents/${DOCUMENT_ID}`,
      { workflowId: 'wf-bio' },
    );
    expect(attemptRepository.update).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({
        providerSessionId: 'didit-ses-1',
        providerWorkflowId: 'wf-bio',
      }),
    );
    expect(session).toEqual(
      expect.objectContaining({
        attemptId: 'attempt-1',
        url: 'https://verify.didit.me/session/abc',
        reused: false,
        signatureCompleted: false,
      }),
    );
  });

  it('una recarga reutiliza la sesión abierta y no crea otra', async () => {
    attemptRepository.findOne.mockResolvedValue({
      id: 'attempt-0',
      status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS,
      documentHash: HASH,
      providerSessionId: 'didit-ses-0',
      providerMetadata: { hostedUrl: 'https://verify.didit.me/session/old' },
      expiresAt: new Date(Date.now() + 60_000),
    });

    const session = await useCase.execute(
      DOCUMENT_ID,
      USER_ID,
      GEO,
      AUTHORIZATION,
    );

    expect(session).toEqual(
      expect.objectContaining({
        attemptId: 'attempt-0',
        url: 'https://verify.didit.me/session/old',
        reused: true,
      }),
    );
    expect(attemptRepository.save).not.toHaveBeenCalled();
    expect(didit.createSession).not.toHaveBeenCalled();
  });

  it('cierra una sesión abierta sobre otro PDF y abre una nueva', async () => {
    attemptRepository.findOne.mockResolvedValue({
      id: 'attempt-0',
      status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING,
      documentHash: 'hash-viejo',
      providerMetadata: { hostedUrl: 'https://verify.didit.me/session/old' },
      expiresAt: null,
    });

    await useCase.execute(DOCUMENT_ID, USER_ID, GEO, AUTHORIZATION);

    expect(attemptRepository.update).toHaveBeenCalledWith(
      {
        id: 'attempt-0',
        status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING,
      },
      expect.objectContaining({
        status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
        failureReason: expect.stringContaining('documento cambió'),
      }),
    );
    expect(didit.createSession).toHaveBeenCalled();
  });

  it('cierra como EXPIRED una sesión vencida y abre una nueva', async () => {
    attemptRepository.findOne.mockResolvedValue({
      id: 'attempt-0',
      status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS,
      documentHash: HASH,
      providerMetadata: { hostedUrl: 'https://verify.didit.me/session/old' },
      expiresAt: new Date(Date.now() - 1000),
    });

    await useCase.execute(DOCUMENT_ID, USER_ID, GEO, AUTHORIZATION);

    expect(attemptRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'attempt-0' }),
      expect.objectContaining({
        status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.EXPIRED,
      }),
    );
    expect(didit.createSession).toHaveBeenCalled();
  });

  it('si otra petición ganó la carrera, devuelve su sesión en vez de abrir otra en Didit', async () => {
    const winner = {
      id: 'attempt-w',
      status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING,
      documentHash: HASH,
      providerMetadata: null,
      expiresAt: null,
    };
    attemptRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    attemptRepository.save.mockRejectedValue(uniqueViolation());

    const session = await useCase.execute(
      DOCUMENT_ID,
      USER_ID,
      GEO,
      AUTHORIZATION,
    );

    expect(session).toEqual(
      expect.objectContaining({ attemptId: 'attempt-w', reused: true }),
    );
    expect(didit.createSession).not.toHaveBeenCalled();
  });

  it('responde 409 si el INSERT choca y ya no hay intento abierto que devolver', async () => {
    attemptRepository.save.mockRejectedValue(uniqueViolation());

    await expect(
      useCase.execute(DOCUMENT_ID, USER_ID, GEO, AUTHORIZATION),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('si Didit falla, deja el intento en FAILED y propaga el error', async () => {
    didit.createSession.mockRejectedValue(new Error('Didit caído'));

    await expect(
      useCase.execute(DOCUMENT_ID, USER_ID, GEO, AUTHORIZATION),
    ).rejects.toThrow('Didit caído');

    expect(attemptRepository.update).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({
        status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
        failureReason: 'Didit caído',
      }),
    );
  });

  it('sin workflow biométrico configurado no crea intento ni llama a Didit', async () => {
    config.get.mockReturnValue(undefined);

    await expect(
      useCase.execute(DOCUMENT_ID, USER_ID, GEO, AUTHORIZATION),
    ).rejects.toBeInstanceOf(DiditConfigurationException);

    expect(attemptRepository.save).not.toHaveBeenCalled();
    expect(didit.createSession).not.toHaveBeenCalled();
  });

  describe('validaciones previas: no se gasta una sesión en una firma que se rechazaría', () => {
    it.each([
      [
        'el documento no está pendiente de firma',
        () => (document.status = DOCUMENT_STATUS_ENUM.SIGNED),
        BadRequestException,
      ],
      [
        'la firma del colaborador no es biométrica',
        () => (me.signatureType = SIGNATURE_TYPE_ENUM.SIMPLE),
        BadRequestException,
      ],
      [
        'el firmante ya respondió',
        () => (me.status = COLLABORATOR_STATUS_ENUM.SIGNED),
        BadRequestException,
      ],
      [
        'falta el código de verificación que el documento exige',
        () => {
          document.requiresVerification = true;
          verificationCodeService.hasConsumedCode.mockResolvedValue(false);
        },
        BadRequestException,
      ],
      [
        'no es su turno en un documento secuencial',
        () => {
          const first = signer({ id: 'col-0', signingOrder: 0, account: {} });
          documentService.findOrLinkMySignerCollaborator.mockResolvedValue({
            signerCollaborators: [first, me],
            myParticipant: me,
          });
        },
        ForbiddenException,
      ],
      [
        'el usuario no es firmante',
        () =>
          documentService.findOrLinkMySignerCollaborator.mockResolvedValue({
            signerCollaborators: [],
            myParticipant: undefined,
          }),
        ForbiddenException,
      ],
    ])('rechaza cuando %s', async (_, arrange, expected) => {
      arrange();

      await expect(
        useCase.execute(DOCUMENT_ID, USER_ID, GEO, AUTHORIZATION),
      ).rejects.toBeInstanceOf(expected);

      expect(attemptRepository.save).not.toHaveBeenCalled();
      expect(didit.createSession).not.toHaveBeenCalled();
    });
  });
});

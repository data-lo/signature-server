import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM } from '../enums/biometric-signature-attempt-status.enum';
import { BiometricSignatureAttemptService } from './biometric-signature-attempt.service';
import {
  BiometricLaunchParams,
  BiometricSessionLauncherService,
} from './biometric-session-launcher.service';

const HASH = 'hash-original';

function uniqueViolation() {
  const error = new QueryFailedError('INSERT', [], new Error('duplicate'));
  (error as unknown as { driverError: { code: string } }).driverError = {
    code: '23505',
  };
  return error;
}

describe('BiometricSessionLauncherService', () => {
  let stored: Record<string, Record<string, unknown>>;
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    findOne: jest.Mock;
    findOneByOrFail: jest.Mock;
  };
  let didit: {
    workflowFor: jest.Mock;
    openAccountSession: jest.Mock;
    openGuestSession: jest.Mock;
  };
  let launcher: BiometricSessionLauncherService;

  function params(overrides: Partial<BiometricLaunchParams> = {}) {
    return {
      resolved: {
        document: { id: 'd-1', originalHash: HASH },
        signer: { id: 'c-1', email: 'ana@correo.mx', account: null },
        signers: [],
      },
      kind: 'GUEST',
      userId: null,
      identity: null,
      geolocation: { latitude: 19.4, longitude: -99.1 },
      ipAddress: '10.0.0.1',
      callbackUrl: 'https://app/p',
      ...overrides,
    } as unknown as BiometricLaunchParams;
  }

  beforeEach(() => {
    stored = {};
    repository = {
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn(async (data) => {
        stored['a-1'] = { ...data, id: 'a-1' };
        return stored['a-1'];
      }),
      update: jest.fn(async (criteria, data) => {
        const id = typeof criteria === 'string' ? criteria : criteria.id;
        stored[id] = { ...(stored[id] ?? {}), ...data };
      }),
      findOne: jest.fn().mockResolvedValue(null),
      findOneByOrFail: jest.fn(async ({ id }) => stored[id]),
    };
    didit = {
      workflowFor: jest.fn((kind) =>
        kind === 'ACCOUNT' ? 'wf-auth' : 'wf-kyc',
      ),
      openAccountSession: jest.fn(),
      openGuestSession: jest.fn().mockResolvedValue({
        sessionId: 'didit-1',
        url: 'https://verify.didit.me/s/1',
        workflowId: 'wf-kyc',
        expiresAt: null,
        raw: { session_id: 'didit-1' },
      }),
    };
    launcher = new BiometricSessionLauncherService(
      repository as never,
      new BiometricSignatureAttemptService(repository as never),
      didit as never,
    );
  });

  it('guarda el intento con su evidencia ANTES de llamar a Didit', async () => {
    const order: string[] = [];
    repository.save.mockImplementation(async (data) => {
      order.push('save');
      stored['a-1'] = { ...data, id: 'a-1' };
      return stored['a-1'];
    });
    didit.openGuestSession.mockImplementation(async () => {
      order.push('didit');
      return {
        sessionId: 'didit-1',
        url: 'https://v/1',
        workflowId: 'wf-kyc',
        expiresAt: null,
        raw: {},
      };
    });

    const session = await launcher.launch(params());

    expect(order).toEqual(['save', 'didit']);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'd-1',
        collaboratorId: 'c-1',
        userId: null,
        emailSnapshot: 'ana@correo.mx',
        identityVerificationId: null,
        providerWorkflowId: 'wf-kyc',
        documentHash: HASH,
        ipAddress: '10.0.0.1',
        consentedAt: expect.any(Date),
      }),
    );
    expect(repository.update).toHaveBeenCalledWith(
      'a-1',
      expect.objectContaining({
        providerSessionId: 'didit-1',
        startedAt: expect.any(Date),
      }),
    );
    expect(session).toEqual(
      expect.objectContaining({
        attemptId: 'a-1',
        url: 'https://v/1',
        reused: false,
      }),
    );
  });

  it('firmante con cuenta: abre Biometric Authentication con su identidad', async () => {
    didit.openAccountSession.mockResolvedValue({
      sessionId: 'didit-2',
      url: 'https://v/2',
      workflowId: 'wf-auth',
      expiresAt: null,
      raw: {},
    });

    await launcher.launch(
      params({
        kind: 'ACCOUNT',
        userId: 'u-1',
        identity: { id: 'iv-1', providerSessionId: 'identity-session' },
      }),
    );

    expect(didit.openAccountSession).toHaveBeenCalledWith({
      attemptId: 'a-1',
      workflowId: 'wf-auth',
      callbackUrl: 'https://app/p',
      identitySessionId: 'identity-session',
    });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-1',
        identityVerificationId: 'iv-1',
      }),
    );
  });

  it('una recarga devuelve la sesión abierta y no abre otra en Didit', async () => {
    repository.findOne.mockResolvedValue({
      id: 'a-0',
      status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS,
      documentHash: HASH,
      providerMetadata: { hostedUrl: 'https://v/0' },
      expiresAt: null,
    });

    const session = await launcher.launch(params());

    expect(session).toEqual(
      expect.objectContaining({
        attemptId: 'a-0',
        url: 'https://v/0',
        reused: true,
      }),
    );
    expect(repository.save).not.toHaveBeenCalled();
    expect(didit.openGuestSession).not.toHaveBeenCalled();
  });

  it('cierra la sesión abierta sobre otro PDF y abre una nueva', async () => {
    repository.findOne.mockResolvedValue({
      id: 'a-0',
      status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING,
      documentHash: 'hash-viejo',
      providerMetadata: { hostedUrl: 'https://v/0' },
      expiresAt: null,
    });

    await launcher.launch(params());

    expect(repository.update).toHaveBeenCalledWith(
      { id: 'a-0', status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING },
      expect.objectContaining({
        status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
        failureReason: expect.stringContaining('documento cambió'),
      }),
    );
    expect(didit.openGuestSession).toHaveBeenCalled();
  });

  it('si otra petición ganó la carrera, devuelve su sesión', async () => {
    repository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'a-w',
      status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING,
      documentHash: HASH,
      providerMetadata: null,
      expiresAt: null,
    });
    repository.save.mockRejectedValue(uniqueViolation());

    await expect(launcher.launch(params())).resolves.toEqual(
      expect.objectContaining({ attemptId: 'a-w', reused: true }),
    );
    expect(didit.openGuestSession).not.toHaveBeenCalled();
  });

  it('responde 409 si choca y ya no hay intento abierto que devolver', async () => {
    repository.save.mockRejectedValue(uniqueViolation());

    await expect(launcher.launch(params())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('si Didit falla, el intento queda en FAILED y el error se propaga', async () => {
    didit.openGuestSession.mockRejectedValue(new Error('Didit caído'));

    await expect(launcher.launch(params())).rejects.toThrow('Didit caído');
    expect(repository.update).toHaveBeenCalledWith(
      'a-1',
      expect.objectContaining({
        status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
        failureReason: 'Didit caído',
      }),
    );
  });
});

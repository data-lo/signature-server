import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { COLLABORATOR_STATUS_ENUM } from '../../enum/collaborator-status.enum';
import { BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM } from '../enums/biometric-signature-attempt-status.enum';
import { BiometricSignatureAttemptService } from '../services/biometric-signature-attempt.service';
import { ProcessBiometricSignatureResultUseCase } from './process-biometric-signature-result.use-case';

const GEO = { latitude: 19.43, longitude: -99.13 };

function payload(overrides: Record<string, unknown> = {}) {
  return {
    application_id: 'app_1',
    event_id: 'evt_1',
    session_id: 'didit-ses-1',
    status: 'Approved',
    timestamp: 1700000000,
    webhook_type: 'status.updated',
    workflow_id: 'wf-bio',
    vendor_data: 'user-1',
    decision: { liveness: { status: 'Approved' } },
    ...overrides,
  };
}

describe('ProcessBiometricSignatureResultUseCase', () => {
  let attempt: Record<string, unknown>;
  let attemptRepository: { findOne: jest.Mock; update: jest.Mock };
  let collaboratorRepository: { findOne: jest.Mock };
  let signDocument: { execute: jest.Mock };
  let useCase: ProcessBiometricSignatureResultUseCase;

  beforeEach(() => {
    attempt = {
      id: 'attempt-1',
      documentId: 'doc-1',
      collaboratorId: 'col-1',
      userId: 'user-1',
      providerSessionId: 'didit-ses-1',
      status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS,
      geolocation: GEO,
      decision: null,
      approvedAt: null,
      completedAt: null,
    };
    attemptRepository = {
      findOne: jest.fn(async ({ where }) =>
        where.providerSessionId === attempt.providerSessionId ? attempt : null,
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    collaboratorRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'col-1',
        status: COLLABORATOR_STATUS_ENUM.PENDING,
      }),
    };
    signDocument = { execute: jest.fn().mockResolvedValue({ success: true }) };

    useCase = new ProcessBiometricSignatureResultUseCase(
      attemptRepository as never,
      collaboratorRepository as never,
      new BiometricSignatureAttemptService(attemptRepository as never),
      signDocument as never,
    );
  });

  it('devuelve false si la sesión no es de una firma biométrica, sin tocar nada', async () => {
    const handled = await useCase.execute(
      payload({ session_id: 'sesion-de-onboarding' }),
    );

    expect(handled).toBe(false);
    expect(attemptRepository.update).not.toHaveBeenCalled();
    expect(signDocument.execute).not.toHaveBeenCalled();
  });

  it('ignora una sesión cuyo vendor_data no es el usuario del intento', async () => {
    const handled = await useCase.execute(
      payload({ vendor_data: 'otro-user' }),
    );

    expect(handled).toBe(true);
    expect(attemptRepository.update).not.toHaveBeenCalled();
    expect(signDocument.execute).not.toHaveBeenCalled();
  });

  describe('aprobación', () => {
    it('marca APPROVED y firma como el usuario del intento, con su ubicación', async () => {
      const handled = await useCase.execute(payload());

      expect(handled).toBe(true);
      expect(attemptRepository.update).toHaveBeenCalledWith(
        'attempt-1',
        expect.objectContaining({
          status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED,
          decision: { liveness: { status: 'Approved' } },
          approvedAt: expect.any(Date),
        }),
      );
      expect(signDocument.execute).toHaveBeenCalledWith(
        'doc-1',
        'user-1',
        undefined,
        GEO,
        undefined,
        'attempt-1',
      );
    });

    it('cierra las demás sesiones abiertas del colaborador tras firmar', async () => {
      await useCase.execute(payload());

      expect(attemptRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ collaboratorId: 'col-1' }),
        expect.objectContaining({
          status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
        }),
      );
    });

    it('si el colaborador ya está firmado, una reentrega no vuelve a firmar', async () => {
      attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED;
      attempt.approvedAt = new Date();
      collaboratorRepository.findOne.mockResolvedValue({
        id: 'col-1',
        status: COLLABORATOR_STATUS_ENUM.SIGNED,
      });

      await useCase.execute(payload());

      expect(signDocument.execute).not.toHaveBeenCalled();
      expect(attemptRepository.update).not.toHaveBeenCalled();
    });

    it('si quedó APPROVED sin firmar (fallo transitorio), el reintento sí firma', async () => {
      attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED;
      attempt.approvedAt = new Date();

      await useCase.execute(payload());

      expect(signDocument.execute).toHaveBeenCalledTimes(1);
    });

    it('gana sobre un EXPIRED que llegó antes: el veredicto de Didit es un hecho', async () => {
      attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.EXPIRED;

      await useCase.execute(payload());

      expect(signDocument.execute).toHaveBeenCalledTimes(1);
    });

    it('no reintenta una aprobación que ya no pudo firmar', async () => {
      attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED;
      attempt.approvedAt = new Date();

      await useCase.execute(payload());

      expect(signDocument.execute).not.toHaveBeenCalled();
    });

    it.each([
      new BadRequestException('El documento no puede firmarse'),
      new ForbiddenException('Aún no es tu turno para firmar este documento'),
    ])(
      'un rechazo de negocio al firmar cierra el intento en FAILED sin propagar (%s)',
      async (rejection) => {
        signDocument.execute.mockRejectedValue(rejection);

        await expect(useCase.execute(payload())).resolves.toBe(true);

        expect(attemptRepository.update).toHaveBeenLastCalledWith(
          'attempt-1',
          expect.objectContaining({
            status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
            failureReason: expect.stringContaining(rejection.message),
          }),
        );
      },
    );

    it('un error inesperado al firmar se propaga para que Didit reintente', async () => {
      signDocument.execute.mockRejectedValue(new Error('MinIO caído'));

      await expect(useCase.execute(payload())).rejects.toThrow('MinIO caído');
    });
  });

  describe('otros resultados', () => {
    it('un rechazo sólo mueve el intento: el colaborador sigue pendiente', async () => {
      await useCase.execute(payload({ status: 'Declined' }));

      expect(attemptRepository.update).toHaveBeenCalledWith(
        {
          id: 'attempt-1',
          status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS,
        },
        expect.objectContaining({
          status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.DECLINED,
          failureReason: expect.any(String),
          completedAt: expect.any(Date),
        }),
      );
      expect(signDocument.execute).not.toHaveBeenCalled();
    });

    it('un estado intermedio no cierra el intento', async () => {
      attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING;

      await useCase.execute(
        payload({ status: 'In Review', decision: undefined }),
      );

      expect(attemptRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'attempt-1' }),
        expect.objectContaining({
          status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_REVIEW,
          completedAt: null,
        }),
      );
    });

    it('un In Progress retrasado no reabre un intento ya aprobado', async () => {
      attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED;

      await useCase.execute(
        payload({ status: 'In Progress', decision: undefined }),
      );

      expect(attemptRepository.update).not.toHaveBeenCalled();
    });

    it('un estado desconocido nunca se lee como aprobación', async () => {
      await useCase.execute(payload({ status: 'Algo Nuevo' }));

      expect(signDocument.execute).not.toHaveBeenCalled();
      expect(attemptRepository.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
        }),
      );
    });
  });
});

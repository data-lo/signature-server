import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM } from '../enums/biometric-signature-attempt-status.enum';
import { ProcessBiometricSignatureResultUseCase } from './process-biometric-signature-result.use-case';

const APPROVED_DECISION = {
  liveness_checks: [
    {
      status: 'Approved',
      score: 97,
      reference_image: 'https://media/selfie.jpg',
    },
  ],
  face_matches: [{ status: 'Approved', score: 92 }],
  id_verifications: [{ status: 'Approved', personal_number: 'CURP' }],
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'didit-1',
    vendor_data: 'biometric-signature-attempt:a-1',
    status: 'Approved',
    decision: APPROVED_DECISION,
    ...overrides,
  };
}

describe('ProcessBiometricSignatureResultUseCase', () => {
  let attempt: Record<string, unknown>;
  let attemptRepository: { update: jest.Mock; find: jest.Mock };
  let collaboratorRepository: { findOne: jest.Mock };
  let documentRepository: { findOne: jest.Mock };
  let signDocument: { executeBiometric: jest.Mock };
  let finalizeCredits: {
    onSignatureSucceeded: jest.Mock;
    onAttemptFailed: jest.Mock;
  };
  let useCase: ProcessBiometricSignatureResultUseCase;

  beforeEach(() => {
    attempt = {
      id: 'a-1',
      documentId: 'd-1',
      collaboratorId: 'c-1',
      userId: 'u-1',
      status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS,
    };
    attemptRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
    };
    documentRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'd-1', status: DOCUMENT_STATUS_ENUM.SIGNED }),
    };
    finalizeCredits = {
      onSignatureSucceeded: jest.fn().mockResolvedValue({
        biometricConsumed: true,
        documentConsumed: false,
      }),
      onAttemptFailed: jest.fn().mockResolvedValue(true),
    };
    collaboratorRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'c-1',
        status: COLLABORATOR_STATUS_ENUM.PENDING,
      }),
    };
    signDocument = {
      executeBiometric: jest.fn().mockResolvedValue({
        success: true,
        data: { id: 'd-1', documentCompleted: false },
      }),
    };
    useCase = new ProcessBiometricSignatureResultUseCase(
      attemptRepository as never,
      collaboratorRepository as never,
      documentRepository as never,
      signDocument as never,
      finalizeCredits as never,
    );
  });

  function run(overrides: Record<string, unknown> = {}) {
    return useCase.execute(attempt as never, payload(overrides));
  }

  it('ignora una entrega cuyo vendor_data no es el de este intento', async () => {
    await run({ vendor_data: 'biometric-signature-attempt:otro' });

    expect(attemptRepository.update).not.toHaveBeenCalled();
    expect(signDocument.executeBiometric).not.toHaveBeenCalled();
  });

  describe('aprobación', () => {
    it('aprueba atómicamente, guarda el veredicto MÍNIMO y registra la firma', async () => {
      await run();

      const [criteria, fields] = attemptRepository.update.mock.calls[0];
      expect(criteria).toEqual(expect.objectContaining({ id: 'a-1' }));
      expect(fields.status).toBe(
        BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED,
      );
      expect(fields.decision.faceMatches).toEqual([
        { status: 'Approved', score: 92, method: null },
      ]);
      expect(JSON.stringify(fields.decision)).not.toMatch(/https|CURP/);
      expect(signDocument.executeBiometric).toHaveBeenCalledWith('a-1');
    });

    it('si otra entrega ya cerró el intento, no vuelve a firmar', async () => {
      attemptRepository.update.mockResolvedValueOnce({ affected: 0 });

      await run();

      expect(signDocument.executeBiometric).not.toHaveBeenCalled();
    });

    it('sin face match aprobado no firma: el intento queda en FAILED', async () => {
      await run({
        decision: {
          liveness_checks: [{ status: 'Approved' }],
          face_matches: [],
        },
      });

      expect(attemptRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a-1' }),
        expect.objectContaining({
          status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
          failureReason: expect.stringContaining('face match'),
        }),
      );
      expect(signDocument.executeBiometric).not.toHaveBeenCalled();
    });

    it('invitado: también exige la verificación de identificación', async () => {
      attempt.userId = null;

      await run({
        decision: {
          liveness_checks: [{ status: 'Approved' }],
          face_matches: [{ status: 'Approved' }],
        },
      });

      expect(signDocument.executeBiometric).not.toHaveBeenCalled();
    });

    it('una aprobación sobre un intento ya cerrado (vencido, rechazado) se ignora', async () => {
      attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.EXPIRED;

      await run();

      expect(attemptRepository.update).not.toHaveBeenCalled();
      expect(signDocument.executeBiometric).not.toHaveBeenCalled();
    });

    it('reentrega con la firma ya registrada: no firma dos veces', async () => {
      attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED;
      collaboratorRepository.findOne.mockResolvedValue({
        id: 'c-1',
        status: COLLABORATOR_STATUS_ENUM.SIGNED,
      });

      await run();

      expect(signDocument.executeBiometric).not.toHaveBeenCalled();
    });

    it('reentrega tras un fallo transitorio (APPROVED sin firmar): retoma la firma', async () => {
      attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED;

      await run();

      expect(signDocument.executeBiometric).toHaveBeenCalledWith('a-1');
    });

    it.each([
      new BadRequestException(
        'El documento cambió después de la verificación biométrica',
      ),
      new ForbiddenException('Aún no es tu turno para firmar este documento'),
    ])(
      'un rechazo de negocio al firmar cierra el intento sin propagar (%s)',
      async (rejection) => {
        signDocument.executeBiometric.mockRejectedValue(rejection);

        await expect(run()).resolves.toBeUndefined();
        expect(attemptRepository.update).toHaveBeenLastCalledWith(
          'a-1',
          expect.objectContaining({
            status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
            failureReason: expect.stringContaining(rejection.message),
          }),
        );
      },
    );

    it('si perdió el claim contra otra entrega que sí firmó, no marca el intento como fallido', async () => {
      signDocument.executeBiometric.mockRejectedValue(
        new BadRequestException('Ya respondiste a esta solicitud de firma'),
      );
      collaboratorRepository.findOne
        .mockResolvedValueOnce({
          id: 'c-1',
          status: COLLABORATOR_STATUS_ENUM.PENDING,
        })
        .mockResolvedValueOnce({
          id: 'c-1',
          status: COLLABORATOR_STATUS_ENUM.SIGNED,
        });

      await run();

      expect(attemptRepository.update).toHaveBeenCalledTimes(1);
    });

    it('un error inesperado se propaga para que Didit reintente', async () => {
      signDocument.executeBiometric.mockRejectedValue(new Error('MinIO caído'));

      await expect(run()).rejects.toThrow('MinIO caído');
    });
  });

  describe('créditos biométricos', () => {
    it('firma biométrica exitosa: consume el crédito del intento, sin el documental si faltan firmantes', async () => {
      await run();

      expect(finalizeCredits.onSignatureSucceeded).toHaveBeenCalledWith({
        biometricSignatureAttemptId: 'a-1',
        documentId: 'd-1',
        documentCompleted: false,
      });
      expect(finalizeCredits.onAttemptFailed).not.toHaveBeenCalled();
    });

    it('documento biométrico completado: pide consumir también el crédito documental', async () => {
      signDocument.executeBiometric.mockResolvedValue({
        success: true,
        data: { id: 'd-1', documentCompleted: true },
      });

      await run();

      expect(finalizeCredits.onSignatureSucceeded).toHaveBeenCalledWith(
        expect.objectContaining({ documentCompleted: true }),
      );
    });

    it('webhook de aprobación repetido: no vuelve a firmar y sólo reintenta el cobro idempotente', async () => {
      attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED;
      collaboratorRepository.findOne.mockResolvedValue({
        id: 'c-1',
        status: COLLABORATOR_STATUS_ENUM.SIGNED,
      });

      await run();
      await run();

      expect(signDocument.executeBiometric).not.toHaveBeenCalled();
      expect(finalizeCredits.onSignatureSucceeded).toHaveBeenCalledTimes(2);
      expect(finalizeCredits.onSignatureSucceeded).toHaveBeenLastCalledWith({
        biometricSignatureAttemptId: 'a-1',
        documentId: 'd-1',
        documentCompleted: true,
      });
    });

    it('si el cobro falla, el error se propaga para que Didit reintente', async () => {
      finalizeCredits.onSignatureSucceeded.mockRejectedValue(
        new Error('lote inconsistente'),
      );

      await expect(run()).rejects.toThrow('lote inconsistente');
    });

    it('perder el claim contra otra entrega que sí firmó cobra igual (idempotente) y no libera', async () => {
      signDocument.executeBiometric.mockRejectedValue(
        new BadRequestException('Ya respondiste a esta solicitud de firma'),
      );
      collaboratorRepository.findOne
        .mockResolvedValueOnce({
          id: 'c-1',
          status: COLLABORATOR_STATUS_ENUM.PENDING,
        })
        .mockResolvedValueOnce({
          id: 'c-1',
          status: COLLABORATOR_STATUS_ENUM.SIGNED,
        });

      await run();

      expect(finalizeCredits.onSignatureSucceeded).toHaveBeenCalledTimes(1);
      expect(finalizeCredits.onAttemptFailed).not.toHaveBeenCalled();
    });

    it('aprobada pero sin firma registrada (rechazo de negocio): libera el crédito del intento', async () => {
      signDocument.executeBiometric.mockRejectedValue(
        new BadRequestException('El documento cambió'),
      );

      await run();

      expect(finalizeCredits.onSignatureSucceeded).not.toHaveBeenCalled();
      expect(finalizeCredits.onAttemptFailed).toHaveBeenCalledWith({
        biometricSignatureAttemptId: 'a-1',
        reason: 'SIGNATURE_NOT_REGISTERED',
      });
    });

    it('libera el crédito de las otras sesiones abiertas que la firma deja sin uso', async () => {
      attemptRepository.find.mockResolvedValue([{ id: 'a-2' }]);

      await run();

      expect(finalizeCredits.onAttemptFailed).toHaveBeenCalledWith({
        biometricSignatureAttemptId: 'a-2',
        reason: 'SIGNED_WITH_ANOTHER_ATTEMPT',
      });
    });

    it.each([
      ['Declined', 'DIDIT_DECLINED'],
      ['Expired', 'DIDIT_EXPIRED'],
      ['Algo Nuevo', 'DIDIT_FAILED'],
    ])('%s libera el crédito biométrico del intento', async (didit, reason) => {
      await run({ status: didit, decision: undefined });

      expect(finalizeCredits.onAttemptFailed).toHaveBeenCalledWith({
        biometricSignatureAttemptId: 'a-1',
        reason,
      });
      expect(finalizeCredits.onSignatureSucceeded).not.toHaveBeenCalled();
    });

    it('webhook de rechazo repetido: la segunda entrega no libera de nuevo', async () => {
      await run({ status: 'Declined', decision: undefined });
      attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.DECLINED;

      await run({ status: 'Declined', decision: undefined });

      expect(finalizeCredits.onAttemptFailed).toHaveBeenCalledTimes(1);
    });

    it('si otra entrega ganó el cierre, ésta no libera', async () => {
      attemptRepository.update.mockResolvedValue({ affected: 0 });

      await run({ status: 'Declined', decision: undefined });

      expect(finalizeCredits.onAttemptFailed).not.toHaveBeenCalled();
    });

    it('un fallo al liberar no tumba la entrega de un rechazo', async () => {
      finalizeCredits.onAttemptFailed.mockRejectedValue(
        new Error('base caída'),
      );

      await expect(
        run({ status: 'Declined', decision: undefined }),
      ).resolves.toBeUndefined();
    });
  });

  describe('otros resultados: el colaborador sigue pendiente', () => {
    it.each([
      ['Declined', BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.DECLINED],
      ['Expired', BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.EXPIRED],
      ['Abandoned', BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.EXPIRED],
      ['Algo Nuevo', BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED],
    ])('%s cierra el intento en %s', async (didit, expected) => {
      await run({ status: didit, decision: undefined });

      expect(attemptRepository.update).toHaveBeenCalledWith(
        {
          id: 'a-1',
          status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS,
        },
        expect.objectContaining({
          status: expected,
          completedAt: expect.any(Date),
        }),
      );
      expect(signDocument.executeBiometric).not.toHaveBeenCalled();
    });

    it('In Review sigue en proceso, sin cerrar', async () => {
      attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING;

      await run({ status: 'In Review', decision: undefined });

      expect(attemptRepository.update).toHaveBeenCalledWith(
        { id: 'a-1', status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING },
        { status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS },
      );
    });

    it('un estado viejo no reabre un intento ya aprobado', async () => {
      attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED;

      await run({ status: 'In Progress', decision: undefined });

      expect(attemptRepository.update).not.toHaveBeenCalled();
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { ProcessDiditVerificationResultUseCase } from './process-didit-verification-result.use-case';
import { UpdateSigningCredentialStatusUseCase } from './update-signing-credential-status.use-case';
import { IdentityVerificationEntity } from '../entities/identity-verification.entity';
import { IDENTITY_VERIFICATION_PROVIDER_ENUM } from '../enums/identity-verification-provider.enum';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';

const SESSION_ID = 'ses_1';
const USER_ID = 'user-1';
const ATTEMPT_ID = 'attempt-1';

describe('ProcessDiditVerificationResultUseCase', () => {
  let useCase: ProcessDiditVerificationResultUseCase;
  let identityVerificationRepository: { findOne: jest.Mock; update: jest.Mock };
  let userRepository: { update: jest.Mock; findOne: jest.Mock };
  let updateSigningCredentialStatus: { applyIfAllowed: jest.Mock };

  function givenAttempt(
    status = IDENTITY_VERIFICATION_STATUS_ENUM.IN_PROGRESS,
  ): void {
    identityVerificationRepository.findOne.mockResolvedValue({
      id: ATTEMPT_ID,
      userId: USER_ID,
      status,
      decision: null,
      completedAt: null,
    });
  }

  beforeEach(async () => {
    identityVerificationRepository = { findOne: jest.fn(), update: jest.fn() };
    // Por defecto, un usuario aprobado que todavía no subió su firma PNG.
    userRepository = {
      update: jest.fn(),
      findOne: jest.fn().mockResolvedValue({ id: USER_ID, signatureId: null }),
    };
    updateSigningCredentialStatus = {
      applyIfAllowed: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProcessDiditVerificationResultUseCase,
        {
          provide: getRepositoryToken(IdentityVerificationEntity),
          useValue: identityVerificationRepository,
        },
        { provide: getRepositoryToken(UserEntity), useValue: userRepository },
        {
          provide: UpdateSigningCredentialStatusUseCase,
          useValue: updateSigningCredentialStatus,
        },
      ],
    }).compile();

    useCase = module.get(ProcessDiditVerificationResultUseCase);
  });

  describe('aprobación', () => {
    beforeEach(() => givenAttempt());

    it('pasa el intento a APPROVED y guarda la decisión de Didit', async () => {
      const decision = { face_match: { status: 'match' } };

      await useCase.execute({
        session_id: SESSION_ID,
        status: 'Approved',
        decision,
      });

      expect(identityVerificationRepository.update).toHaveBeenCalledWith(
        ATTEMPT_ID,
        expect.objectContaining({
          status: IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED,
          decision,
          failureReason: null,
          completedAt: expect.any(Date),
        }),
      );
    });

    it('marca identityVerifiedAt en el usuario', async () => {
      await useCase.execute({ session_id: SESSION_ID, status: 'Approved' });

      expect(userRepository.update).toHaveBeenCalledWith(USER_ID, {
        identityVerifiedAt: expect.any(Date),
      });
    });

    it('deja al usuario en SIGNATURE_PENDING: sólo le falta subir su firma PNG', async () => {
      await useCase.execute({ session_id: SESSION_ID, status: 'Approved' });

      expect(updateSigningCredentialStatus.applyIfAllowed).toHaveBeenCalledWith(
        USER_ID,
        SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING,
      );
    });

    it('no hace retroceder a quien ya tenía su firma registrada (reentrega del webhook)', async () => {
      userRepository.findOne.mockResolvedValue({
        id: USER_ID,
        signatureId: 'sig-1',
      });

      await useCase.execute({ session_id: SESSION_ID, status: 'Approved' });

      expect(updateSigningCredentialStatus.applyIfAllowed).toHaveBeenCalledWith(
        USER_ID,
        SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED,
      );
    });
  });

  describe('el resultado mueve el estado global del usuario', () => {
    it.each([
      [
        'In Progress',
        SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_IN_PROGRESS,
      ],
      [
        'In Review',
        SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_IN_REVIEW,
      ],
      [
        'Declined',
        SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_RETRY_REQUIRED,
      ],
      [
        'Abandoned',
        SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_RETRY_REQUIRED,
      ],
      [
        'Expired',
        SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_RETRY_REQUIRED,
      ],
      [
        'Something New',
        SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_RETRY_REQUIRED,
      ],
    ])('"%s" deja la credencial en %s', async (diditStatus, expected) => {
      givenAttempt(IDENTITY_VERIFICATION_STATUS_ENUM.PENDING);

      await useCase.execute({ session_id: SESSION_ID, status: diditStatus });

      expect(updateSigningCredentialStatus.applyIfAllowed).toHaveBeenCalledWith(
        USER_ID,
        expected,
      );
    });
  });

  describe('mapeo de estados de Didit', () => {
    it.each([
      ['Not Started', IDENTITY_VERIFICATION_STATUS_ENUM.PENDING],
      ['In Progress', IDENTITY_VERIFICATION_STATUS_ENUM.IN_PROGRESS],
      ['In Review', IDENTITY_VERIFICATION_STATUS_ENUM.IN_REVIEW],
      ['in_review', IDENTITY_VERIFICATION_STATUS_ENUM.IN_REVIEW],
      ['Declined', IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED],
      ['Abandoned', IDENTITY_VERIFICATION_STATUS_ENUM.ABANDONED],
      ['Kyc Expired', IDENTITY_VERIFICATION_STATUS_ENUM.EXPIRED],
    ])('mapea "%s" a %s', async (diditStatus, expected) => {
      givenAttempt(IDENTITY_VERIFICATION_STATUS_ENUM.PENDING);

      await useCase.execute({ session_id: SESSION_ID, status: diditStatus });

      expect(identityVerificationRepository.update).toHaveBeenCalledWith(
        ATTEMPT_ID,
        expect.objectContaining({ status: expected }),
      );
    });

    it('un estado desconocido nunca aprueba: cae en FAILED', async () => {
      givenAttempt(IDENTITY_VERIFICATION_STATUS_ENUM.PENDING);

      await useCase.execute({
        session_id: SESSION_ID,
        status: 'Something New',
      });

      expect(identityVerificationRepository.update).toHaveBeenCalledWith(
        ATTEMPT_ID,
        expect.objectContaining({
          status: IDENTITY_VERIFICATION_STATUS_ENUM.FAILED,
        }),
      );
      expect(userRepository.update).not.toHaveBeenCalled();
    });
  });

  it('no degrada una identidad ya aprobada si llega un evento fuera de orden', async () => {
    givenAttempt(IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED);

    await useCase.execute({ session_id: SESSION_ID, status: 'In Progress' });

    expect(identityVerificationRepository.update).not.toHaveBeenCalled();
    expect(updateSigningCredentialStatus.applyIfAllowed).not.toHaveBeenCalled();
  });

  /**
   * El bug del reporte: la sesión se reporta expirada (la URL "ya fue consumida") y el `Approved`
   * de la verificación que el usuario sí completó llega después. Antes chocaba con la guarda de
   * estados terminales y se descartaba en silencio, dejando al usuario sin poder avanzar.
   */
  describe('una aprobación posterior a un estado terminal no aprobado', () => {
    it.each([
      ['Expired', IDENTITY_VERIFICATION_STATUS_ENUM.EXPIRED],
      ['Abandoned', IDENTITY_VERIFICATION_STATUS_ENUM.ABANDONED],
      ['Declined', IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED],
      ['Failed', IDENTITY_VERIFICATION_STATUS_ENUM.FAILED],
    ])('se aplica sobre un intento en %s', async (_label, previous) => {
      givenAttempt(previous);

      await useCase.execute({ session_id: SESSION_ID, status: 'Approved' });

      expect(identityVerificationRepository.update).toHaveBeenCalledWith(
        ATTEMPT_ID,
        expect.objectContaining({
          status: IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED,
          // El motivo del rechazo anterior se limpia: dejarlo colgado haría que la pantalla
          // mostrara un fallo sobre una identidad ya aprobada.
          failureReason: null,
        }),
      );
      expect(userRepository.update).toHaveBeenCalledWith(USER_ID, {
        identityVerifiedAt: expect.any(Date),
      });
      expect(updateSigningCredentialStatus.applyIfAllowed).toHaveBeenCalledWith(
        USER_ID,
        SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING,
      );
    });
  });

  it('guarda el motivo del rechazo', async () => {
    givenAttempt();

    await useCase.execute({
      session_id: SESSION_ID,
      status: 'Declined',
      decision: { reason: 'El rostro no coincide con la identificación' },
    });

    expect(identityVerificationRepository.update).toHaveBeenCalledWith(
      ATTEMPT_ID,
      expect.objectContaining({
        status: IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED,
        failureReason: 'El rostro no coincide con la identificación',
      }),
    );
  });

  it('reconcilia por vendor_data el intento que quedó sin session_id', async () => {
    identityVerificationRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: ATTEMPT_ID,
        userId: USER_ID,
        status: IDENTITY_VERIFICATION_STATUS_ENUM.PENDING,
        decision: null,
        completedAt: null,
      });

    await useCase.execute({
      session_id: SESSION_ID,
      status: 'Approved',
      vendor_data: USER_ID,
    });

    expect(identityVerificationRepository.findOne).toHaveBeenLastCalledWith({
      where: {
        provider: IDENTITY_VERIFICATION_PROVIDER_ENUM.DIDIT,
        userId: USER_ID,
        providerSessionId: IsNull(),
      },
      order: { createdAt: 'DESC' },
    });
    expect(identityVerificationRepository.update).toHaveBeenCalledWith(
      ATTEMPT_ID,
      { providerSessionId: SESSION_ID },
    );
  });

  it('ignora sin fallar un webhook de una sesión ajena', async () => {
    identityVerificationRepository.findOne.mockResolvedValue(null);

    await expect(
      useCase.execute({
        session_id: 'ses_de_otro_entorno',
        status: 'Approved',
      }),
    ).resolves.toBeUndefined();

    expect(identityVerificationRepository.update).not.toHaveBeenCalled();
    expect(userRepository.update).not.toHaveBeenCalled();
  });

  it('ignora sin fallar un payload sin session_id', async () => {
    await expect(
      useCase.execute({ status: 'Approved' }),
    ).resolves.toBeUndefined();

    expect(identityVerificationRepository.findOne).not.toHaveBeenCalled();
  });
});

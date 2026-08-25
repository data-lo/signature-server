import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { SigningCredentialNotReadyException } from 'src/identity-verification/exceptions/identity-verification.exceptions';
import { SignatureCaptureSessionEntity } from '../entities/signature-capture-session.entity';
import { SIGNATURE_CAPTURE_CHANNEL_ENUM } from '../enums/signature-capture-channel.enum';
import { SIGNATURE_CAPTURE_SESSION_STATUS_ENUM } from '../enums/signature-capture-session-status.enum';
import {
  InvalidSignatureCaptureTokenException,
  SignatureCaptureSessionForbiddenException,
} from '../exceptions/signature-capture.exceptions';
import { SignatureCaptureSessionService } from '../signature-capture-session.service';
import { ClaimMobileSignatureSessionUseCase } from './claim-mobile-signature-session.use-case';

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const SESSION_ID = 'session-1';
const TOKEN = 'token-del-qr';
const S = SIGNING_CREDENTIAL_STATUS_ENUM;
const CHANNEL = SIGNATURE_CAPTURE_CHANNEL_ENUM;
const STATUS = SIGNATURE_CAPTURE_SESSION_STATUS_ENUM;

describe('ClaimMobileSignatureSessionUseCase', () => {
  let useCase: ClaimMobileSignatureSessionUseCase;
  let sessionRepository: { update: jest.Mock };
  let userRepository: { findOne: jest.Mock };
  let sessions: { findByToken: jest.Mock; toStatusResponse: jest.Mock };

  function givenUserAt(status: SIGNING_CREDENTIAL_STATUS_ENUM): void {
    userRepository.findOne.mockResolvedValue({
      id: USER_ID,
      signingCredentialStatus: status,
    });
  }

  function givenSession(
    session: Partial<SignatureCaptureSessionEntity> = {},
  ): void {
    sessions.findByToken.mockResolvedValue({
      id: SESSION_ID,
      userId: USER_ID,
      channel: CHANNEL.MOBILE_QR,
      status: STATUS.PENDING,
      expiresAt: new Date('2026-08-24T12:10:00.000Z'),
      claimedAt: null,
      completedAt: null,
      signatureFileId: null,
      ...session,
    });
  }

  beforeEach(async () => {
    sessionRepository = { update: jest.fn() };
    userRepository = { findOne: jest.fn() };
    sessions = {
      findByToken: jest.fn(),
      toStatusResponse: jest.fn((session) => session),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaimMobileSignatureSessionUseCase,
        {
          provide: getRepositoryToken(SignatureCaptureSessionEntity),
          useValue: sessionRepository,
        },
        { provide: getRepositoryToken(UserEntity), useValue: userRepository },
        { provide: SignatureCaptureSessionService, useValue: sessions },
      ],
    }).compile();

    useCase = module.get(ClaimMobileSignatureSessionUseCase);
    givenUserAt(S.SIGNATURE_PENDING);
    givenSession();
  });

  it('ata la captura al teléfono que canjeó el token', async () => {
    const result = await useCase.execute(USER_ID, TOKEN);

    expect(sessions.findByToken).toHaveBeenCalledWith(TOKEN);
    expect(sessionRepository.update).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ status: STATUS.CLAIMED }),
    );
    expect(result).toMatchObject({ status: STATUS.CLAIMED });
  });

  /**
   * El caso que da sentido a todo el flujo: el QR es visible para cualquiera que pase junto a la
   * pantalla. Tener el token no basta — hay que ser el dueño de la sesión.
   */
  it('no deja que otro usuario autenticado reclame la sesión', async () => {
    await expect(useCase.execute(OTHER_USER_ID, TOKEN)).rejects.toBeInstanceOf(
      SignatureCaptureSessionForbiddenException,
    );

    expect(sessionRepository.update).not.toHaveBeenCalled();
  });

  describe('tokens que ya no sirven', () => {
    /**
     * El token es de un solo uso: reclamar saca la sesión de PENDING, así que un segundo canje
     * del mismo código no encuentra nada reclamable. Todos los casos dan el mismo error opaco
     * para no confirmarle a nadie qué tokens fueron reales.
     */
    it.each([
      STATUS.CLAIMED,
      STATUS.COMPLETED,
      STATUS.CANCELLED,
      STATUS.EXPIRED,
    ])('rechaza una sesión en %s', async (status) => {
      givenSession({ status });

      await expect(useCase.execute(USER_ID, TOKEN)).rejects.toBeInstanceOf(
        InvalidSignatureCaptureTokenException,
      );

      expect(sessionRepository.update).not.toHaveBeenCalled();
    });

    it('rechaza un token que apunte a una captura de escritorio', async () => {
      givenSession({ channel: CHANNEL.DESKTOP });

      await expect(useCase.execute(USER_ID, TOKEN)).rejects.toBeInstanceOf(
        InvalidSignatureCaptureTokenException,
      );
    });
  });

  /**
   * Entre que se generó el QR y se escaneó pudo pasar cualquier cosa con la credencial: por eso
   * el estado del usuario se vuelve a mirar acá y no sólo al abrir la sesión.
   */
  it('rechaza al usuario cuya credencial dejó de habilitar la firma', async () => {
    givenUserAt(S.IDENTITY_VERIFICATION_RETRY_REQUIRED);

    await expect(useCase.execute(USER_ID, TOKEN)).rejects.toBeInstanceOf(
      SigningCredentialNotReadyException,
    );

    expect(sessionRepository.update).not.toHaveBeenCalled();
  });
});

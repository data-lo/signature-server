import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { SignatureCaptureSessionEntity } from '../entities/signature-capture-session.entity';
import { SIGNATURE_CAPTURE_CHANNEL_ENUM } from '../enums/signature-capture-channel.enum';
import { SIGNATURE_CAPTURE_SESSION_STATUS_ENUM } from '../enums/signature-capture-session-status.enum';
import { SignatureCaptureSessionNotUsableException } from '../exceptions/signature-capture.exceptions';
import { SignatureCaptureSessionService } from '../signature-capture-session.service';
import { CancelSignatureCaptureSessionUseCase } from './cancel-signature-capture-session.use-case';

const USER_ID = 'user-1';
const SESSION_ID = 'session-1';
const STATUS = SIGNATURE_CAPTURE_SESSION_STATUS_ENUM;

describe('CancelSignatureCaptureSessionUseCase', () => {
  let useCase: CancelSignatureCaptureSessionUseCase;
  let sessionRepository: { update: jest.Mock };
  let sessions: { findOwnedById: jest.Mock; toStatusResponse: jest.Mock };

  function givenSession(
    session: Partial<SignatureCaptureSessionEntity> = {},
  ): void {
    sessions.findOwnedById.mockResolvedValue({
      id: SESSION_ID,
      userId: USER_ID,
      channel: SIGNATURE_CAPTURE_CHANNEL_ENUM.MOBILE_QR,
      status: STATUS.PENDING,
      expiresAt: new Date('2026-08-24T12:10:00.000Z'),
      ...session,
    });
  }

  beforeEach(async () => {
    sessionRepository = { update: jest.fn() };
    sessions = {
      findOwnedById: jest.fn(),
      toStatusResponse: jest.fn((session) => session),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CancelSignatureCaptureSessionUseCase,
        {
          provide: getRepositoryToken(SignatureCaptureSessionEntity),
          useValue: sessionRepository,
        },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: {
            findOne: jest.fn().mockResolvedValue({
              id: USER_ID,
              signingCredentialStatus:
                SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING,
            }),
          },
        },
        { provide: SignatureCaptureSessionService, useValue: sessions },
      ],
    }).compile();

    useCase = module.get(CancelSignatureCaptureSessionUseCase);
    givenSession();
  });

  /** Cancelar es lo que invalida el QR en el acto, sin esperar a que venza. */
  it.each([STATUS.PENDING, STATUS.CLAIMED])(
    'cancela una captura en %s',
    async (status) => {
      givenSession({ status });

      const result = await useCase.execute(SESSION_ID, USER_ID);

      expect(sessionRepository.update).toHaveBeenCalledWith(SESSION_ID, {
        status: STATUS.CANCELLED,
      });
      expect(result).toMatchObject({ status: STATUS.CANCELLED });
    },
  );

  /**
   * El intento ya está muerto, que es el resultado pedido: devolver un error obligaría a la
   * pantalla a distinguir dos formas de "ya no hay nada que cancelar" para tratarlas igual.
   */
  it.each([STATUS.CANCELLED, STATUS.EXPIRED])(
    'no hace nada, ni falla, sobre una captura en %s',
    async (status) => {
      givenSession({ status });

      const result = await useCase.execute(SESSION_ID, USER_ID);

      expect(sessionRepository.update).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status });
    },
  );

  it('no deja cancelar una captura ya completada', async () => {
    givenSession({ status: STATUS.COMPLETED });

    await expect(useCase.execute(SESSION_ID, USER_ID)).rejects.toBeInstanceOf(
      SignatureCaptureSessionNotUsableException,
    );

    expect(sessionRepository.update).not.toHaveBeenCalled();
  });
});

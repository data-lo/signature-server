import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { SigningCredentialNotReadyException } from 'src/identity-verification/exceptions/identity-verification.exceptions';
import { SignatureCaptureSessionEntity } from '../entities/signature-capture-session.entity';
import { SIGNATURE_CAPTURE_CHANNEL_ENUM } from '../enums/signature-capture-channel.enum';
import { SIGNATURE_CAPTURE_SESSION_STATUS_ENUM } from '../enums/signature-capture-session-status.enum';
import { SignatureCaptureSessionInProgressException } from '../exceptions/signature-capture.exceptions';
import { SignatureCaptureSessionService } from '../signature-capture-session.service';
import { hashSignatureCaptureToken } from '../utils/signature-capture-token.util';
import { CreateSignatureCaptureSessionUseCase } from './create-signature-capture-session.use-case';

const USER_ID = 'user-1';
const S = SIGNING_CREDENTIAL_STATUS_ENUM;
const CHANNEL = SIGNATURE_CAPTURE_CHANNEL_ENUM;
const STATUS = SIGNATURE_CAPTURE_SESSION_STATUS_ENUM;
const EXPIRES_AT = new Date('2026-08-24T12:10:00.000Z');

describe('CreateSignatureCaptureSessionUseCase', () => {
  let useCase: CreateSignatureCaptureSessionUseCase;
  let userRepository: { findOne: jest.Mock };
  let sessions: {
    findActiveForUser: jest.Mock;
    buildExpiresAt: jest.Mock;
  };
  let manager: { update: jest.Mock; create: jest.Mock; save: jest.Mock };

  function givenUserAt(status: SIGNING_CREDENTIAL_STATUS_ENUM): void {
    userRepository.findOne.mockResolvedValue({
      id: USER_ID,
      signingCredentialStatus: status,
    });
  }

  function givenActiveSession(
    session: Partial<SignatureCaptureSessionEntity>,
  ): void {
    sessions.findActiveForUser.mockResolvedValue({
      id: 'session-old',
      userId: USER_ID,
      status: STATUS.PENDING,
      channel: CHANNEL.DESKTOP,
      expiresAt: EXPIRES_AT,
      ...session,
    });
  }

  beforeEach(async () => {
    userRepository = { findOne: jest.fn() };
    sessions = {
      findActiveForUser: jest.fn().mockResolvedValue(null),
      buildExpiresAt: jest.fn().mockReturnValue(EXPIRES_AT),
    };
    manager = {
      update: jest.fn(),
      create: jest.fn((_entity, data) => data),
      save: jest.fn(async (data) => ({ id: 'session-new', ...data })),
    };

    const sessionRepository = {
      manager: {
        transaction: jest.fn(async (work: (m: unknown) => unknown) =>
          work(manager),
        ),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateSignatureCaptureSessionUseCase,
        {
          provide: getRepositoryToken(SignatureCaptureSessionEntity),
          useValue: sessionRepository,
        },
        { provide: getRepositoryToken(UserEntity), useValue: userRepository },
        { provide: SignatureCaptureSessionService, useValue: sessions },
      ],
    }).compile();

    useCase = module.get(CreateSignatureCaptureSessionUseCase);
    givenUserAt(S.SIGNATURE_PENDING);
  });

  describe('con la identidad aprobada (SIGNATURE_PENDING)', () => {
    it('abre una sesión DESKTOP sin token ni QR', async () => {
      const result = await useCase.execute(USER_ID, CHANNEL.DESKTOP);

      expect(result).toMatchObject({
        id: 'session-new',
        channel: CHANNEL.DESKTOP,
        status: STATUS.PENDING,
        token: null,
        qrUrl: null,
        reused: false,
      });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ tokenHash: null, expiresAt: EXPIRES_AT }),
      );
    });

    it('emite un token de un solo uso para MOBILE_QR y guarda sólo su hash', async () => {
      const result = await useCase.execute(USER_ID, CHANNEL.MOBILE_QR);

      expect(result.token).toEqual(expect.any(String));
      expect(result.qrUrl).toContain(
        `token=${encodeURIComponent(result.token)}`,
      );

      const persisted = manager.save.mock.calls[0][0];
      expect(persisted.tokenHash).toBe(hashSignatureCaptureToken(result.token));
      // El token en claro no puede quedar en ninguna columna.
      expect(JSON.stringify(persisted)).not.toContain(result.token);
    });

    it('genera un token distinto en cada sesión', async () => {
      const first = await useCase.execute(USER_ID, CHANNEL.MOBILE_QR);
      const second = await useCase.execute(USER_ID, CHANNEL.MOBILE_QR);

      expect(first.token).not.toBe(second.token);
    });
  });

  describe('estados que no habilitan la captura', () => {
    it.each([
      S.IDENTITY_VERIFICATION_REQUIRED,
      S.IDENTITY_VERIFICATION_PENDING,
      S.IDENTITY_VERIFICATION_IN_PROGRESS,
      S.IDENTITY_VERIFICATION_IN_REVIEW,
      S.IDENTITY_VERIFICATION_RETRY_REQUIRED,
      S.IDENTITY_VERIFICATION_FAILED,
      S.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED,
      S.CONFIGURED,
    ])('rechaza a un usuario en %s explicándole el motivo', async (status) => {
      givenUserAt(status);

      await expect(
        useCase.execute(USER_ID, CHANNEL.MOBILE_QR),
      ).rejects.toBeInstanceOf(SigningCredentialNotReadyException);

      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('cuando ya hay una sesión activa', () => {
    it('devuelve la misma sesión DESKTOP en vez de abrir otra', async () => {
      givenActiveSession({ channel: CHANNEL.DESKTOP, status: STATUS.PENDING });

      const result = await useCase.execute(USER_ID, CHANNEL.DESKTOP);

      expect(result).toMatchObject({ id: 'session-old', reused: true });
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('rota el QR cancelando la sesión sin reclamar y abriendo otra', async () => {
      givenActiveSession({
        channel: CHANNEL.MOBILE_QR,
        status: STATUS.PENDING,
      });

      const result = await useCase.execute(USER_ID, CHANNEL.MOBILE_QR);

      expect(result).toMatchObject({ id: 'session-new', reused: false });
      expect(manager.update).toHaveBeenCalledWith(
        SignatureCaptureSessionEntity,
        { userId: USER_ID, status: STATUS.PENDING },
        { status: STATUS.CANCELLED },
      );
    });

    it('protege la captura que un teléfono ya reclamó', async () => {
      givenActiveSession({
        channel: CHANNEL.MOBILE_QR,
        status: STATUS.CLAIMED,
      });

      await expect(
        useCase.execute(USER_ID, CHANNEL.MOBILE_QR),
      ).rejects.toBeInstanceOf(SignatureCaptureSessionInProgressException);

      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  /**
   * Dos peticiones simultáneas del mismo usuario: la que pierde la carrera choca con el índice
   * único parcial. El usuario tiene que ver el mismo 409 que si hubiera una captura en curso, no
   * un 500 con el error crudo de Postgres.
   */
  it('traduce la violación del índice único en un conflicto entendible', async () => {
    manager.save.mockRejectedValue(
      Object.assign(
        new QueryFailedError('INSERT', [], new Error('duplicate key')),
        { driverError: { code: '23505' } },
      ),
    );

    await expect(
      useCase.execute(USER_ID, CHANNEL.MOBILE_QR),
    ).rejects.toBeInstanceOf(SignatureCaptureSessionInProgressException);
  });

  it('deja subir cualquier otro fallo de base sin disfrazarlo', async () => {
    manager.save.mockRejectedValue(new Error('conexión perdida'));

    await expect(useCase.execute(USER_ID, CHANNEL.MOBILE_QR)).rejects.toThrow(
      'conexión perdida',
    );
  });
});

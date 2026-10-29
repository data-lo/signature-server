import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { SignatureCaptureSessionEntity } from './entities/signature-capture-session.entity';
import { SIGNATURE_CAPTURE_CHANNEL_ENUM } from './enums/signature-capture-channel.enum';
import { SIGNATURE_CAPTURE_SESSION_STATUS_ENUM } from './enums/signature-capture-session-status.enum';
import {
  InvalidSignatureCaptureTokenException,
  SignatureCaptureSessionForbiddenException,
} from './exceptions/signature-capture.exceptions';
import { SignatureCaptureSessionService } from './signature-capture-session.service';
import { SIGNATURE_CAPTURE_SESSION_TTL_MINUTES } from './constants/signature-capture.constants';
import { hashSignatureCaptureToken } from './utils/signature-capture-token.util';

const USER_ID = 'user-1';
const SESSION_ID = 'session-1';
const STATUS = SIGNATURE_CAPTURE_SESSION_STATUS_ENUM;

const IN_FIVE_MINUTES = new Date(Date.now() + 5 * 60 * 1000);
const FIVE_MINUTES_AGO = new Date(Date.now() - 5 * 60 * 1000);

function session(
  overrides: Partial<SignatureCaptureSessionEntity> = {},
): SignatureCaptureSessionEntity {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    channel: SIGNATURE_CAPTURE_CHANNEL_ENUM.MOBILE_QR,
    status: STATUS.PENDING,
    tokenHash: 'hash',
    expiresAt: IN_FIVE_MINUTES,
    claimedAt: null,
    completedAt: null,
    signatureFileId: null,
    ...overrides,
  } as SignatureCaptureSessionEntity;
}

describe('SignatureCaptureSessionService', () => {
  let service: SignatureCaptureSessionService;
  let repository: { findOne: jest.Mock; update: jest.Mock };

  beforeEach(async () => {
    repository = { findOne: jest.fn(), update: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SignatureCaptureSessionService,
        {
          provide: getRepositoryToken(SignatureCaptureSessionEntity),
          useValue: repository,
        },
      ],
    }).compile();

    service = module.get(SignatureCaptureSessionService);
  });

  describe('buildExpiresAt', () => {
    it('vence a los minutos configurados', () => {
      const from = new Date('2026-08-24T12:00:00.000Z');

      expect(service.buildExpiresAt(from).toISOString()).toBe(
        new Date(
          from.getTime() + SIGNATURE_CAPTURE_SESSION_TTL_MINUTES * 60 * 1000,
        ).toISOString(),
      );
    });
  });

  describe('findActiveForUser', () => {
    it('devuelve la sesión viva del usuario', async () => {
      repository.findOne.mockResolvedValue(session());

      await expect(service.findActiveForUser(USER_ID)).resolves.toMatchObject({
        id: SESSION_ID,
        status: STATUS.PENDING,
      });
    });

    /**
     * Sin materializar el vencimiento, el índice único parcial seguiría viendo una fila PENDING
     * y le bloquearía al usuario la creación de cualquier captura nueva, para siempre.
     */
    it('marca EXPIRED la sesión vencida y la da por inexistente', async () => {
      repository.findOne.mockResolvedValue(
        session({ expiresAt: FIVE_MINUTES_AGO }),
      );

      await expect(service.findActiveForUser(USER_ID)).resolves.toBeNull();

      expect(repository.update).toHaveBeenCalledWith(SESSION_ID, {
        status: STATUS.EXPIRED,
      });
    });

    it('devuelve null si el usuario no tiene ninguna', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.findActiveForUser(USER_ID)).resolves.toBeNull();
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('findOwnedById', () => {
    it('devuelve la sesión de su dueño', async () => {
      repository.findOne.mockResolvedValue(session());

      await expect(
        service.findOwnedById(SESSION_ID, USER_ID),
      ).resolves.toMatchObject({ id: SESSION_ID });
    });

    /**
     * El orden importa: "existe" antes que "es tuya". Contestar 403 sobre un id inventado
     * confirmaría a un tercero qué identificadores son reales.
     */
    it('responde 404 cuando la sesión no existe', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.findOwnedById(SESSION_ID, USER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('responde 403 cuando la sesión es de otro usuario', async () => {
      repository.findOne.mockResolvedValue(session({ userId: 'user-2' }));

      await expect(
        service.findOwnedById(SESSION_ID, USER_ID),
      ).rejects.toBeInstanceOf(SignatureCaptureSessionForbiddenException);
    });

    it('reporta como EXPIRED una sesión que venció mientras la PC sondeaba', async () => {
      repository.findOne.mockResolvedValue(
        session({ expiresAt: FIVE_MINUTES_AGO }),
      );

      await expect(
        service.findOwnedById(SESSION_ID, USER_ID),
      ).resolves.toMatchObject({ status: STATUS.EXPIRED });
    });

    it('no reabre el vencimiento de una sesión ya completada', async () => {
      repository.findOne.mockResolvedValue(
        session({ status: STATUS.COMPLETED, expiresAt: FIVE_MINUTES_AGO }),
      );

      await expect(
        service.findOwnedById(SESSION_ID, USER_ID),
      ).resolves.toMatchObject({ status: STATUS.COMPLETED });

      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('findByToken', () => {
    /** El token en claro no existe en base: la búsqueda sólo puede ser por su hash. */
    it('busca por el hash del token, nunca por el token', async () => {
      repository.findOne.mockResolvedValue(session());

      await service.findByToken('token-en-claro');

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { tokenHash: hashSignatureCaptureToken('token-en-claro') },
      });
    });

    it('rechaza un token que no corresponde a ninguna sesión', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.findByToken('inventado')).rejects.toBeInstanceOf(
        InvalidSignatureCaptureTokenException,
      );
    });
  });

  describe('toStatusResponse', () => {
    it('no expone el token ni su hash', () => {
      const response = service.toStatusResponse(
        session(),
        SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING,
      );

      expect(response).not.toHaveProperty('tokenHash');
      expect(response).not.toHaveProperty('token');
      expect(response).toMatchObject({
        id: SESSION_ID,
        signingCredentialStatus:
          SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING,
      });
    });
  });
});

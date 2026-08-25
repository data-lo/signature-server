import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { SignatureCaptureSessionEntity } from '../entities/signature-capture-session.entity';
import { SIGNATURE_CAPTURE_CHANNEL_ENUM } from '../enums/signature-capture-channel.enum';
import { SIGNATURE_CAPTURE_SESSION_STATUS_ENUM } from '../enums/signature-capture-session-status.enum';
import {
  InvalidSignatureImageException,
  SignatureCaptureSessionNotUsableException,
} from '../exceptions/signature-capture.exceptions';
import { SignatureCaptureSessionService } from '../signature-capture-session.service';
import { SaveHandwrittenSignatureUseCase } from './save-handwritten-signature.use-case';
import { UploadSignatureImageUseCase } from './upload-signature-image.use-case';

const USER_ID = 'user-1';
const SESSION_ID = 'session-1';
const SIGNATURE_ID = 'sig-1';
const CHANNEL = SIGNATURE_CAPTURE_CHANNEL_ENUM;
const STATUS = SIGNATURE_CAPTURE_SESSION_STATUS_ENUM;

/** Los 8 bytes de cabecera de un PNG real, más un relleno cualquiera. */
const PNG_FILE = {
  originalname: 'firma.png',
  mimetype: 'image/png',
  buffer: Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
  ]),
} as Express.Multer.File;

/** Un JPEG con el `mimetype` mentido: la cabecera es lo único que no miente. */
const FAKE_PNG_FILE = {
  originalname: 'firma.png',
  mimetype: 'image/png',
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
} as Express.Multer.File;

describe('SaveHandwrittenSignatureUseCase', () => {
  let useCase: SaveHandwrittenSignatureUseCase;
  let sessionRepository: { update: jest.Mock };
  let userRepository: { findOne: jest.Mock };
  let sessions: { findOwnedById: jest.Mock; toStatusResponse: jest.Mock };
  let uploadSignatureImage: { execute: jest.Mock };

  function givenSession(
    session: Partial<SignatureCaptureSessionEntity> = {},
  ): void {
    sessions.findOwnedById.mockResolvedValue({
      id: SESSION_ID,
      userId: USER_ID,
      channel: CHANNEL.MOBILE_QR,
      status: STATUS.CLAIMED,
      expiresAt: new Date('2026-08-24T12:10:00.000Z'),
      claimedAt: new Date('2026-08-24T12:01:00.000Z'),
      completedAt: null,
      signatureFileId: null,
      ...session,
    });
  }

  beforeEach(async () => {
    sessionRepository = { update: jest.fn() };
    userRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: USER_ID,
        signingCredentialStatus: SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED,
      }),
    };
    sessions = {
      findOwnedById: jest.fn(),
      toStatusResponse: jest.fn((session, status) => ({
        ...session,
        signingCredentialStatus: status,
      })),
    };
    uploadSignatureImage = {
      execute: jest.fn().mockResolvedValue({
        success: true,
        message: 'Firma registrada correctamente',
        data: { id: SIGNATURE_ID },
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SaveHandwrittenSignatureUseCase,
        {
          provide: getRepositoryToken(SignatureCaptureSessionEntity),
          useValue: sessionRepository,
        },
        { provide: getRepositoryToken(UserEntity), useValue: userRepository },
        { provide: SignatureCaptureSessionService, useValue: sessions },
        {
          provide: UploadSignatureImageUseCase,
          useValue: uploadSignatureImage,
        },
      ],
    }).compile();

    useCase = module.get(SaveHandwrittenSignatureUseCase);
    givenSession();
  });

  it('registra la firma y cierra la captura con el archivo que produjo', async () => {
    const result = await useCase.execute(SESSION_ID, USER_ID, PNG_FILE);

    expect(uploadSignatureImage.execute).toHaveBeenCalledWith(
      USER_ID,
      { signatureImage: PNG_FILE },
      { signatureImage: [PNG_FILE] },
    );
    expect(sessionRepository.update).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        status: STATUS.COMPLETED,
        signatureFileId: SIGNATURE_ID,
      }),
    );
    expect(result.data).toMatchObject({
      status: STATUS.COMPLETED,
      signatureFileId: SIGNATURE_ID,
      // Lo que la PC necesita ver para continuar sin reiniciar el flujo.
      signingCredentialStatus: SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED,
    });
  });

  it('no marca la captura como completada si el alta de la firma falla', async () => {
    uploadSignatureImage.execute.mockRejectedValue(new Error('MinIO caído'));

    await expect(
      useCase.execute(SESSION_ID, USER_ID, PNG_FILE),
    ).rejects.toThrow('MinIO caído');

    expect(sessionRepository.update).not.toHaveBeenCalled();
  });

  describe('validación del archivo', () => {
    it('rechaza una petición sin archivo', async () => {
      await expect(
        useCase.execute(SESSION_ID, USER_ID, undefined),
      ).rejects.toBeInstanceOf(InvalidSignatureImageException);

      expect(uploadSignatureImage.execute).not.toHaveBeenCalled();
    });

    /**
     * El `mimetype` lo escribe el cliente: dice `image/png` y los bytes son de un JPEG. Quien
     * decide es la cabecera del archivo.
     */
    it('rechaza un archivo que sólo dice ser PNG', async () => {
      await expect(
        useCase.execute(SESSION_ID, USER_ID, FAKE_PNG_FILE),
      ).rejects.toBeInstanceOf(InvalidSignatureImageException);

      expect(uploadSignatureImage.execute).not.toHaveBeenCalled();
    });
  });

  describe('sesiones que no admiten la firma', () => {
    it.each([STATUS.COMPLETED, STATUS.CANCELLED, STATUS.EXPIRED])(
      'rechaza una captura en %s',
      async (status) => {
        givenSession({ status });

        await expect(
          useCase.execute(SESSION_ID, USER_ID, PNG_FILE),
        ).rejects.toBeInstanceOf(SignatureCaptureSessionNotUsableException);

        expect(uploadSignatureImage.execute).not.toHaveBeenCalled();
      },
    );

    /**
     * Sin esto bastaría con conocer el `id` de la sesión para mandar una firma, y el canje del
     * token —donde se comprueba que el teléfono está autenticado como el mismo usuario— quedaría
     * de adorno.
     */
    it('exige haber reclamado la sesión cuando la captura es por QR', async () => {
      givenSession({ channel: CHANNEL.MOBILE_QR, status: STATUS.PENDING });

      await expect(
        useCase.execute(SESSION_ID, USER_ID, PNG_FILE),
      ).rejects.toBeInstanceOf(SignatureCaptureSessionNotUsableException);
    });

    it('acepta la firma de una captura de escritorio sin reclamo previo', async () => {
      givenSession({ channel: CHANNEL.DESKTOP, status: STATUS.PENDING });

      await expect(
        useCase.execute(SESSION_ID, USER_ID, PNG_FILE),
      ).resolves.toMatchObject({ success: true });
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { PersonalInformationEntity } from 'src/user/entities/personal-information.entity';
import { MinioService } from 'src/common/minio/minio.service';
import { BUCKET_TYPES_ENUM } from 'src/common/minio/enums/bucket-types.enum';
import { StoreVerifiedIdentityImagesUseCase } from './store-verified-identity-images.use-case';
import { DiditMediaDownloaderService } from '../didit/didit-media-downloader.service';
import { IdentityDocumentImagesProcessingException } from '../exceptions/identity-verification.exceptions';

const USER_ID = 'user-1';
const PERSONAL_INFORMATION_ID = 'pi-1';
const VERIFICATION_ID = 'verif-1';

/** Token de las URLs prefirmadas de Didit: no puede terminar en la base ni en un error. */
const URL_SECRET = 'X-Amz-Signature=secreto';
const FRONT_URL = `https://media.didit.me/front.jpg?${URL_SECRET}`;
const BACK_URL = `https://media.didit.me/back.jpg?${URL_SECRET}`;
const DECISION = {
  id_verifications: [{ front_image: FRONT_URL, back_image: BACK_URL }],
};

const EXPECTED_FRONT_KEY = `${PERSONAL_INFORMATION_ID}/${VERIFICATION_ID}/front.jpg`;
const EXPECTED_BACK_KEY = `${PERSONAL_INFORMATION_ID}/${VERIFICATION_ID}/back.jpg`;

describe('StoreVerifiedIdentityImagesUseCase', () => {
  let useCase: StoreVerifiedIdentityImagesUseCase;
  let userRepository: { findOne: jest.Mock };
  let personalInformationRepository: { findOne: jest.Mock; update: jest.Mock };
  let mediaDownloader: { download: jest.Mock };
  let minioService: { putSensitiveObject: jest.Mock };
  /** Bytes que entregó el descargador, para comprobar que se borran de memoria. */
  let downloaded: Buffer[];

  beforeEach(async () => {
    downloaded = [];
    userRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: USER_ID,
        personalInformationId: PERSONAL_INFORMATION_ID,
      }),
    };
    personalInformationRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: PERSONAL_INFORMATION_ID,
        frontImageKey: null,
        backImageKey: null,
      }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    mediaDownloader = {
      download: jest.fn(async (_url: string, side: string) => {
        const content = Buffer.concat([
          Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
          Buffer.from(`ine-${side}`),
        ]);
        downloaded.push(content);
        return { content, contentType: 'image/jpeg', extension: 'jpg' };
      }),
    };
    minioService = {
      putSensitiveObject: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StoreVerifiedIdentityImagesUseCase,
        { provide: getRepositoryToken(UserEntity), useValue: userRepository },
        {
          provide: getRepositoryToken(PersonalInformationEntity),
          useValue: personalInformationRepository,
        },
        { provide: DiditMediaDownloaderService, useValue: mediaDownloader },
        { provide: MinioService, useValue: minioService },
      ],
    }).compile();

    useCase = module.get(StoreVerifiedIdentityImagesUseCase);
  });

  /**
   * Ejecuta el guardado para el intento de prueba.
   *
   * @param decision - Veredicto de Didit; por defecto, uno con las dos imágenes.
   * @returns La promesa del caso de uso.
   *
   * @example
   * await store();
   */
  const store = (decision: Record<string, unknown> | null = DECISION) =>
    useCase.execute({
      userId: USER_ID,
      verificationId: VERIFICATION_ID,
      decision,
    });

  describe('webhook exitoso', () => {
    it('descarga las dos caras de la INE desde las URLs del veredicto', async () => {
      await store();

      expect(mediaDownloader.download).toHaveBeenCalledWith(
        FRONT_URL,
        'frontal',
      );
      expect(mediaDownloader.download).toHaveBeenCalledWith(
        BACK_URL,
        'trasera',
      );
    });

    it('las guarda en el bucket privado con llaves por intento', async () => {
      await store();

      expect(minioService.putSensitiveObject).toHaveBeenCalledWith(
        BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
        EXPECTED_FRONT_KEY,
        expect.any(Buffer),
        'image/jpeg',
      );
      expect(minioService.putSensitiveObject).toHaveBeenCalledWith(
        BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
        EXPECTED_BACK_KEY,
        expect.any(Buffer),
        'image/jpeg',
      );
    });

    it('guarda en personal_information sólo las llaves internas', async () => {
      await store();

      expect(personalInformationRepository.update).toHaveBeenCalledWith(
        PERSONAL_INFORMATION_ID,
        { frontImageKey: EXPECTED_FRONT_KEY, backImageKey: EXPECTED_BACK_KEY },
      );
      const written = JSON.stringify(
        personalInformationRepository.update.mock.calls[0],
      );
      expect(written).not.toMatch(/https?:\/\//);
      expect(written).not.toContain(URL_SECRET);
    });

    it('borra de memoria los bytes descargados una vez subidos', async () => {
      await store();

      expect(downloaded).toHaveLength(2);
      for (const content of downloaded) {
        expect(content.every((byte) => byte === 0)).toBe(true);
      }
    });
  });

  describe('reintento del webhook', () => {
    /** Idempotencia: el mismo intento ya guardado no se descarga ni se sobrescribe. */
    it('no descarga ni sobrescribe si las llaves de este intento ya están guardadas', async () => {
      personalInformationRepository.findOne.mockResolvedValue({
        id: PERSONAL_INFORMATION_ID,
        frontImageKey: EXPECTED_FRONT_KEY,
        backImageKey: EXPECTED_BACK_KEY,
      });

      await store();

      expect(mediaDownloader.download).not.toHaveBeenCalled();
      expect(minioService.putSensitiveObject).not.toHaveBeenCalled();
      expect(personalInformationRepository.update).not.toHaveBeenCalled();
    });

    it('un intento que falló a medias vuelve a escribir en las mismas llaves, sin duplicar', async () => {
      personalInformationRepository.findOne.mockResolvedValue({
        id: PERSONAL_INFORMATION_ID,
        frontImageKey: EXPECTED_FRONT_KEY,
        backImageKey: null,
      });

      await store();

      const keys = minioService.putSensitiveObject.mock.calls.map(
        (call) => call[1],
      );
      expect(keys).toEqual([EXPECTED_FRONT_KEY, EXPECTED_BACK_KEY]);
    });

    it('una verificación nueva reemplaza las llaves de una anterior', async () => {
      personalInformationRepository.findOne.mockResolvedValue({
        id: PERSONAL_INFORMATION_ID,
        frontImageKey: `${PERSONAL_INFORMATION_ID}/verif-viejo/front.jpg`,
        backImageKey: `${PERSONAL_INFORMATION_ID}/verif-viejo/back.jpg`,
      });

      await store();

      expect(personalInformationRepository.update).toHaveBeenCalledWith(
        PERSONAL_INFORMATION_ID,
        { frontImageKey: EXPECTED_FRONT_KEY, backImageKey: EXPECTED_BACK_KEY },
      );
    });
  });

  describe('imagen faltante', () => {
    it.each([
      [
        'sin la imagen trasera',
        { id_verifications: [{ front_image: FRONT_URL }] },
      ],
      [
        'sin la imagen frontal',
        { id_verifications: [{ back_image: BACK_URL }] },
      ],
      ['sin veredicto', null],
    ])('falla %s, sin descargar ni guardar nada', async (_caso, decision) => {
      await expect(store(decision)).rejects.toBeInstanceOf(
        IdentityDocumentImagesProcessingException,
      );
      expect(mediaDownloader.download).not.toHaveBeenCalled();
      expect(minioService.putSensitiveObject).not.toHaveBeenCalled();
      expect(personalInformationRepository.update).not.toHaveBeenCalled();
    });

    it('si una descarga falla no guarda nada y borra la otra imagen', async () => {
      mediaDownloader.download.mockImplementation(
        async (_url: string, side: string) => {
          if (side === 'trasera') {
            throw new IdentityDocumentImagesProcessingException(
              'la imagen trasera respondió HTTP 403',
            );
          }
          const content = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
          downloaded.push(content);
          return { content, contentType: 'image/jpeg', extension: 'jpg' };
        },
      );

      await expect(store()).rejects.toThrow('HTTP 403');
      expect(minioService.putSensitiveObject).not.toHaveBeenCalled();
      expect(personalInformationRepository.update).not.toHaveBeenCalled();
      expect(downloaded[0].every((byte) => byte === 0)).toBe(true);
    });
  });

  describe('fallo de MinIO', () => {
    it('propaga un error reintentable y no toca las llaves', async () => {
      minioService.putSensitiveObject.mockRejectedValue(
        new Error(
          'No se pudo almacenar un objeto sensible en MinIO (AccessDenied).',
        ),
      );

      const error = await store().catch((e: Error) => e);

      expect(error).toBeInstanceOf(IdentityDocumentImagesProcessingException);
      expect((error as Error).message).toContain('AccessDenied');
      expect((error as Error).message).not.toContain(URL_SECRET);
      expect(personalInformationRepository.update).not.toHaveBeenCalled();
    });
  });

  it('falla si el usuario no tiene información personal', async () => {
    userRepository.findOne.mockResolvedValue(null);

    await expect(store()).rejects.toBeInstanceOf(
      IdentityDocumentImagesProcessingException,
    );
    expect(mediaDownloader.download).not.toHaveBeenCalled();
  });
});

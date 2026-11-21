import { BUCKET_TYPES_ENUM } from 'src/common/minio/enums/bucket-types.enum';

import { CollaboratorEntity } from '../../entities/collaborator.entity';
import { SEALING_TYPE_ENUM } from '../enums/sealing-type.enum';
import {
  IncompleteAdvancedSignatureEvidenceException,
  IncompleteSimpleSignatureDataException,
  SealingRequestSnapshotMismatchException,
} from '../exceptions/seal.exceptions';
import {
  AdvancedSealingRequestSnapshot,
  SimpleSealingRequestSnapshot,
} from '../interfaces/sealing-request-snapshot.interface';
import {
  SealingRequestSnapshotService,
  sha256Hex,
} from './sealing-request-snapshot.service';

const HASHES = {
  documentId: 'doc-1',
  originalHash: 'hash-original',
  signedHash: 'hash-firmado',
};

/** Firmante simple con todo lo que exige el payload, tal como lo devuelve el query builder. */
function buildSimpleSigner(): CollaboratorEntity {
  return {
    id: 'collaborator-1',
    resolvedAt: new Date('2026-11-19T18:00:00.000Z'),
    signatureSnapshotObjectKey: 'snapshots/rubrica-1.png',
    account: {
      user: {
        email: 'luis.martinez@correo.example',
        firstName: 'Luis (copia de users)',
        lastName: 'Martínez',
        nationalId: 'CURP-DE-USERS',
        signature: { signatureObjectKey: 'firma-en-vivo.png' },
        personalInformation: {
          curp: 'MAML800101HDFRRS09',
          name: 'Luis',
          lastName: 'Martínez',
          frontImageKey: 'verificacion-1/front.jpg',
          backImageKey: 'verificacion-1/back.jpg',
        },
      },
    },
  } as unknown as CollaboratorEntity;
}

/** Firma avanzada persistida (releída de jsonb: fechas como string). */
const ADVANCED_SIGNATURE = {
  originalHash: 'hash-original',
  signatureBase64: 'firma-en-base64',
  algorithm: 'sha256',
  signedAt: '2026-11-19T18:00:00.000Z',
  certificate: {
    rfc: 'PEAJ800101XXX',
    name: 'JUAN PEREZ',
    issuer: 'SERVICIO DE ADMINISTRACION TRIBUTARIA',
    serialNumber: '1',
    certificateNumber: '2',
    certificatePem: 'pem',
  },
  ocspEvidence: {
    status: 'good',
    verifiedAt: '2026-11-19T18:05:00.000Z',
    ocspResponse: 'respuesta-ocsp',
    ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
  },
};

describe('SealingRequestSnapshotService', () => {
  let service: SealingRequestSnapshotService;
  let signers: CollaboratorEntity[];
  let collaboratorRepository: {
    createQueryBuilder: jest.Mock;
    find: jest.Mock;
  };
  let documentRepository: { findOneOrFail: jest.Mock };
  let verificationCodeRepository: { findOne: jest.Mock };
  let minioService: {
    putSensitiveObject: jest.Mock;
    getSensitiveObject: jest.Mock;
    removeSensitiveObject: jest.Mock;
  };
  /** Lo que se "guardó" en MinIO, por llave. */
  let stored: Map<string, Buffer>;

  beforeEach(() => {
    signers = [buildSimpleSigner()];
    stored = new Map();

    const builder: Record<string, jest.Mock> = {};
    for (const method of [
      'leftJoinAndSelect',
      'addSelect',
      'where',
      'andWhere',
      'orderBy',
    ]) {
      builder[method] = jest.fn(() => builder);
    }
    builder.getMany = jest.fn(async () => structuredClone(signers));

    collaboratorRepository = {
      createQueryBuilder: jest.fn(() => builder),
      find: jest.fn(),
    };
    documentRepository = {
      findOneOrFail: jest
        .fn()
        .mockResolvedValue({ id: 'doc-1', originalHash: 'hash-original' }),
    };
    verificationCodeRepository = {
      findOne: jest.fn().mockResolvedValue({
        code: '483920',
        usedAt: new Date('2026-11-19T17:59:00.000Z'),
      }),
    };
    minioService = {
      putSensitiveObject: jest.fn(
        async (_bucket: BUCKET_TYPES_ENUM, key: string, content: Buffer) => {
          stored.set(key, Buffer.from(content));
        },
      ),
      getSensitiveObject: jest.fn(
        async (_bucket: BUCKET_TYPES_ENUM, key: string) => stored.get(key)!,
      ),
      removeSensitiveObject: jest.fn().mockResolvedValue(undefined),
    };

    service = new SealingRequestSnapshotService(
      documentRepository as never,
      collaboratorRepository as never,
      verificationCodeRepository as never,
      minioService as never,
    );
  });

  describe('firma simple', () => {
    it('congela identidad, OTP, fecha y referencias de imágenes en el bucket privado', async () => {
      const reference = await service.freezeSimpleSignatureRequest(HASHES);

      expect(minioService.putSensitiveObject).toHaveBeenCalledWith(
        BUCKET_TYPES_ENUM.SEALING_REQUESTS,
        reference.objectKey,
        expect.any(Buffer),
        'application/json',
      );
      expect(reference.objectKey).toMatch(/^doc-1\/[0-9a-f-]{36}\.json$/);
      expect(reference.hash).toBe(sha256Hex(stored.get(reference.objectKey)!));

      const snapshot = (await service.load(
        reference,
      )) as SimpleSealingRequestSnapshot;
      expect(snapshot).toEqual({
        version: 1,
        sealType: SEALING_TYPE_ENUM.SIMPLE,
        documentId: 'doc-1',
        originalHash: 'hash-original',
        signedHash: 'hash-firmado',
        frozenAt: expect.any(String),
        signatures: [
          {
            collaboratorId: 'collaborator-1',
            // La identidad canónica de personal_information, no la copia de users.
            curp: 'MAML800101HDFRRS09',
            email: 'luis.martinez@correo.example',
            name: 'Luis',
            lastName: 'Martínez',
            signedAt: '2026-11-19T18:00:00.000Z',
            verificationData: {
              code: '483920',
              verificationMethod: 'EMAIL_OTP',
              usedAt: '2026-11-19T17:59:00.000Z',
            },
            // El snapshot inmutable de la rúbrica, no la firma en vivo del perfil.
            signatureImageObjectKey: 'snapshots/rubrica-1.png',
            identityDocumentFrontImageKey: 'verificacion-1/front.jpg',
            identityDocumentBackImageKey: 'verificacion-1/back.jpg',
          },
        ],
      });
    });

    it('no descarga ninguna imagen: sólo guarda sus llaves', async () => {
      await service.freezeSimpleSignatureRequest(HASHES);

      expect(minioService.getSensitiveObject).not.toHaveBeenCalled();
      expect(minioService.putSensitiveObject).toHaveBeenCalledTimes(1);
    });

    /**
     * Criterio de la historia: el payload que se reintenta es el del cierre, aunque el firmante
     * cambie su perfil, su firma o vuelva a verificar su INE después.
     */
    it('el snapshot no cambia aunque después se modifique el perfil del firmante', async () => {
      const reference = await service.freezeSimpleSignatureRequest(HASHES);
      const before = await service.load(reference);

      const user = signers[0].account!.user as unknown as {
        personalInformation: Record<string, string>;
        signature: Record<string, string>;
      };
      user.personalInformation.curp = 'OTRA-CURP';
      user.personalInformation.name = 'Otro nombre';
      user.personalInformation.frontImageKey = 'verificacion-2/front.jpg';
      user.signature.signatureObjectKey = 'firma-nueva.png';

      expect(await service.load(reference)).toEqual(before);
      // Congelar de nuevo sí vería el cambio: por eso el trabajo guarda la referencia del cierre.
      const again = (await service.load(
        await service.freezeSimpleSignatureRequest(HASHES),
      )) as SimpleSealingRequestSnapshot;
      expect(again.signatures[0].curp).toBe('OTRA-CURP');
    });

    it('rechaza un payload cuyo contenido ya no coincide con el hash registrado', async () => {
      const reference = await service.freezeSimpleSignatureRequest(HASHES);
      stored.set(reference.objectKey, Buffer.from('{"alterado":true}'));

      await expect(service.load(reference)).rejects.toThrow(
        SealingRequestSnapshotMismatchException,
      );
    });

    it.each([
      [
        'la CURP',
        (signer: any) => {
          signer.account.user.personalInformation.curp = null;
          signer.account.user.nationalId = null;
        },
      ],
      [
        'la imagen frontal de la INE verificada',
        (signer: any) => {
          signer.account.user.personalInformation.frontImageKey = null;
        },
      ],
      [
        'la fecha de firma',
        (signer: any) => {
          signer.resolvedAt = null;
        },
      ],
    ])('sin %s lanza y no sube nada', async (missing, mutate) => {
      mutate(signers[0]);

      await expect(
        service.freezeSimpleSignatureRequest(HASHES),
      ).rejects.toThrow(
        new IncompleteSimpleSignatureDataException(missing, 'collaborator-1'),
      );
      expect(minioService.putSensitiveObject).not.toHaveBeenCalled();
    });

    it('sin código de verificación consumido lanza y no sube nada', async () => {
      verificationCodeRepository.findOne.mockResolvedValue(null);

      await expect(
        service.freezeSimpleSignatureRequest(HASHES),
      ).rejects.toBeInstanceOf(IncompleteSimpleSignatureDataException);
      expect(minioService.putSensitiveObject).not.toHaveBeenCalled();
    });
  });

  describe('firma avanzada', () => {
    it('congela el payload de Seal Service con las firmas persistidas, sin llave ni contraseña', async () => {
      collaboratorRepository.find.mockResolvedValue([
        { id: 'p-1', advancedSignature: ADVANCED_SIGNATURE },
      ]);

      const reference = await service.freezeAdvancedSignatureRequest('doc-1');
      const snapshot = (await service.load(
        reference,
      )) as AdvancedSealingRequestSnapshot;

      expect(snapshot.sealType).toBe(SEALING_TYPE_ENUM.ADVANCED);
      expect(snapshot.request).toEqual({
        documentId: 'doc-1',
        originalHash: 'hash-original',
        signatures: [
          {
            signatureBase64: 'firma-en-base64',
            algorithm: 'sha256',
            signedAt: '2026-11-19T18:00:00.000Z',
            certificate: ADVANCED_SIGNATURE.certificate,
            ocspEvidence: ADVANCED_SIGNATURE.ocspEvidence,
          },
        ],
      });
      expect(stored.get(reference.objectKey)!.toString()).not.toMatch(
        /privateKey|password|\.key/i,
      );
    });

    it('sin la evidencia OCSP de un firmante no congela nada', async () => {
      const { ocspEvidence: _omit, ...withoutOcsp } = ADVANCED_SIGNATURE;
      collaboratorRepository.find.mockResolvedValue([
        { id: 'p-1', advancedSignature: ADVANCED_SIGNATURE },
        { id: 'p-2', advancedSignature: withoutOcsp },
      ]);

      await expect(
        service.freezeAdvancedSignatureRequest('doc-1'),
      ).rejects.toThrow(
        new IncompleteAdvancedSignatureEvidenceException(
          'la evidencia OCSP',
          'p-2',
        ),
      );
      expect(minioService.putSensitiveObject).not.toHaveBeenCalled();
    });
  });

  it('discard borra el objeto y nunca lanza', async () => {
    minioService.removeSensitiveObject.mockRejectedValue(
      new Error('AccessDenied'),
    );

    await expect(service.discard('doc-1/x.json')).resolves.toBeUndefined();
    expect(minioService.removeSensitiveObject).toHaveBeenCalledWith(
      BUCKET_TYPES_ENUM.SEALING_REQUESTS,
      'doc-1/x.json',
    );
  });
});

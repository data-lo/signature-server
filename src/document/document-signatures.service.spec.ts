import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DocumentSignaturesService } from './document-signatures.service';
import { DocumentEntity } from './entities/document.entity';
import { CollaboratorEntity } from './entities/collaborator.entity';
import { NotificationEntity } from './entities/notification.entity';
import { MinioService } from 'src/shared/minio/minio.service';
import { HashService } from 'src/shared/hash/hash.service';
import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';
import { AccountMemberService } from 'src/account/account-member.service';
import { VerificationCodeService } from './verification-code.service';
import { NotificationEventsProducer } from 'src/kafka/notification-events.producer';
import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';
import { COLABORATOR_TYPE_ENUM } from './enum/colaborator-type.enum';
import {
  CreateDocumentSignaturesDto,
  PAYLOAD_COLABORATOR_TYPE_ENUM,
  PAYLOAD_SIGNATURE_TYPE_ENUM,
} from './dto/create-document-signatures.dto';

function createMockRepository() {
  let seq = 0;
  return {
    create: jest.fn((data) => ({ ...data })),
    save: jest.fn(async (entity) => ({
      id: entity.id ?? `id-${++seq}`,
      ...entity,
    })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

describe('DocumentSignaturesService', () => {
  let service: DocumentSignaturesService;
  let documentRepo: ReturnType<typeof createMockRepository>;
  let collaboratorRepo: ReturnType<typeof createMockRepository>;
  let notificationRepo: ReturnType<typeof createMockRepository>;
  let dataSource: { transaction: jest.Mock };
  let minioService: Record<string, jest.Mock>;
  let hashService: Record<string, jest.Mock>;
  let documentSigningService: Record<string, jest.Mock>;
  let accountMemberService: Record<string, jest.Mock>;
  let verificationCodeService: Record<string, jest.Mock>;
  let notificationEventsProducer: Record<string, jest.Mock>;

  const baseDto: CreateDocumentSignaturesDto = {
    documentData: {
      objectKey: 'object-key-1.pdf',
      fileName: 'contrato.pdf',
      fileType: 'application/pdf',
    },
    collaborators: [
      {
        email: 'firmante@correo.com',
        colaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER,
        signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM.SIMPLE,
        signingOrder: 0,
      },
    ],
    viewers: [{ email: 'viewer@correo.com' }],
  };

  beforeEach(async () => {
    documentRepo = createMockRepository();
    collaboratorRepo = createMockRepository();
    notificationRepo = createMockRepository();

    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === DocumentEntity) return documentRepo;
        if (entity === CollaboratorEntity) return collaboratorRepo;
        if (entity === NotificationEntity) return notificationRepo;
        throw new Error('repositorio no mockeado');
      }),
    };

    dataSource = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) =>
        cb(manager),
      ),
    };

    minioService = {
      getFileInBytesFormat: jest
        .fn()
        .mockResolvedValue(Buffer.from('%PDF-1.4')),
    };
    hashService = { generateFileHash: jest.fn().mockResolvedValue('hash-123') };
    documentSigningService = { getPdfPages: jest.fn().mockResolvedValue(3) };
    accountMemberService = {
      assertIsActiveMember: jest
        .fn()
        .mockResolvedValue({ id: 'account-1', organizationId: null }),
    };
    verificationCodeService = {
      issue: jest.fn().mockResolvedValue({ id: 'vc-1' }),
    };
    notificationEventsProducer = { emitCreated: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentSignaturesService,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: MinioService, useValue: minioService },
        { provide: HashService, useValue: hashService },
        { provide: PdfSignatureService, useValue: documentSigningService },
        { provide: AccountMemberService, useValue: accountMemberService },
        { provide: VerificationCodeService, useValue: verificationCodeService },
        {
          provide: NotificationEventsProducer,
          useValue: notificationEventsProducer,
        },
      ],
    }).compile();

    service = module.get<DocumentSignaturesService>(DocumentSignaturesService);
  });

  it('Escenario 1: crea Document + N Collaborators + N Notifications + verification_code y publica N eventos Kafka', async () => {
    const dtoConVerificacion: CreateDocumentSignaturesDto = {
      ...baseDto,
      collaborators: [
        {
          ...baseDto.collaborators[0],
          signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM.ADVANCED,
          rfc: 'PEGJ850101ABC',
        },
      ],
    };

    const result = await service.create(
      'creator-1',
      'account-1',
      dtoConVerificacion,
      '127.0.0.1',
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe(DOCUMENT_STATUS_ENUM.PENDING);
    // 1 signer + 1 viewer = 2 colaboradores, 2 notificaciones
    expect(collaboratorRepo.save).toHaveBeenCalledTimes(2);
    expect(notificationRepo.save).toHaveBeenCalledTimes(2);
    expect(result.data.collaboratorsCount).toBe(2);
    expect(result.data.notificationsCount).toBe(2);
    // Solo el firmante ADVANCED necesita verification_code
    expect(verificationCodeService.issue).toHaveBeenCalledTimes(1);
    expect(result.data.verificationCodesCount).toBe(1);
    // documento marcado requiresVerification porque alguien lo necesitó
    expect(documentRepo.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ requiresVerification: true }),
    );
    // N eventos Kafka = N notificaciones
    expect(notificationEventsProducer.emitCreated).toHaveBeenCalledTimes(2);
  });

  it('el colaborador watcher tiene colaboratorType WATCHER y no genera verification_code', async () => {
    await service.create('creator-1', 'account-1', baseDto, '127.0.0.1');

    const viewerCollaboratorCall = collaboratorRepo.create.mock.calls.find(
      (call) => call[0].email === 'viewer@correo.com',
    );
    expect(viewerCollaboratorCall[0].colaboratorType).toBe(
      COLABORATOR_TYPE_ENUM.WATCHER,
    );
    expect(verificationCodeService.issue).not.toHaveBeenCalled();
  });

  it('Escenario 2: si falla la inserción dentro de la transacción, no se publica ningún evento a Kafka', async () => {
    collaboratorRepo.save.mockRejectedValueOnce(new Error('DB caída'));

    await expect(
      service.create('creator-1', 'account-1', baseDto, '127.0.0.1'),
    ).rejects.toThrow('DB caída');

    expect(notificationEventsProducer.emitCreated).not.toHaveBeenCalled();
  });

  it('Escenario 3: firma ADVANCED sin rfc se rechaza con BadRequestException antes de abrir la transacción', async () => {
    const dtoSinRfc: CreateDocumentSignaturesDto = {
      ...baseDto,
      collaborators: [
        {
          ...baseDto.collaborators[0],
          signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM.ADVANCED,
          // sin rfc
        },
      ],
    };

    await expect(
      service.create('creator-1', 'account-1', dtoSinRfc, '127.0.0.1'),
    ).rejects.toThrow(BadRequestException);

    expect(minioService.getFileInBytesFormat).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(notificationEventsProducer.emitCreated).not.toHaveBeenCalled();
  });

  it('el signatureType a nivel documento se hereda cuando el colaborador no trae el suyo propio', async () => {
    const dtoConDefault: CreateDocumentSignaturesDto = {
      ...baseDto,
      signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM.ADVANCED,
      collaborators: [
        {
          email: 'firmante@correo.com',
          colaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER,
          rfc: 'PEGJ850101ABC',
          // sin signatureType propio: hereda ADVANCED del documento
        },
      ],
    };

    await service.create('creator-1', 'account-1', dtoConDefault, '127.0.0.1');

    // Heredó ADVANCED -> requiere verification_code aunque no lo haya marcado explícito
    expect(verificationCodeService.issue).toHaveBeenCalledTimes(1);
  });

  it('rechaza con BadRequestException si falta el header X-Account-Id', async () => {
    await expect(
      service.create(
        'creator-1',
        undefined as unknown as string,
        baseDto,
        '127.0.0.1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(accountMemberService.assertIsActiveMember).not.toHaveBeenCalled();
  });
});

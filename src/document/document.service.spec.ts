import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DocumentService } from './document.service';
import { DocumentEntity } from './entities/document.entity';
import { DocumentParticipantEntity } from './entities/document-participant.entity';
import { MinioService } from 'src/shared/minio/minio.service';
import { HashService } from 'src/shared/hash/hash.service';
import { UserService } from 'src/user/user.service';
import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';
import { SignatureService } from 'src/signature/signature.service';
import { EmailService } from 'src/shared/email/email.service';
import { AuditService } from 'src/audit/audit.service';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

describe('DocumentService', () => {
  let service: DocumentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentService,
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(DocumentParticipantEntity),
          useValue: createMockRepository(),
        },
        {
          provide: MinioService,
          useValue: {
            uploadObject: jest.fn(),
            getFile: jest.fn(),
            getFileInBytesFormat: jest.fn(),
            uploadPdfAObject: jest.fn(),
            deleteFile: jest.fn(),
            replaceFile: jest.fn(),
          },
        },
        {
          provide: HashService,
          useValue: {
            generateFileHash: jest.fn(),
            generateRegistryHash: jest.fn(),
            generateCiperHash: jest.fn(),
            reverseCiperHash: jest.fn(),
          },
        },
        {
          provide: UserService,
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: PdfSignatureService,
          useValue: {
            getPdfPages: jest.fn(),
            mergeSignatureIntoPdf: jest.fn(),
            addSignerName: jest.fn(),
            stampRejectedWatermark: jest.fn(),
            stampCancelledWatermark: jest.fn(),
          },
        },
        {
          provide: SignatureService,
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: EmailService,
          useValue: {
            sendDocumentPendingNotification: jest.fn(),
            sendDocumentSignedNotification: jest.fn(),
            sendDocumentRejectedNotification: jest.fn(),
            sendDocumentCancellationPendingNotification: jest.fn(),
            sendDocumentCancelledNotification: jest.fn(),
          },
        },
        {
          provide: AuditService,
          useValue: {
            create: jest.fn(),
          },
        },
        {
          provide: DocumentEventsProducer,
          useValue: {
            emitCreated: jest.fn(),
            emitSentToSign: jest.fn(),
            emitSigned: jest.fn(),
            emitRejected: jest.fn(),
            emitCancelled: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<DocumentService>(DocumentService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

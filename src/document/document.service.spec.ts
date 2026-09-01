import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DocumentService } from './document.service';
import { DocumentEntity } from './entities/document.entity';
import { CollaboratorEntity } from './entities/collaborator.entity';
import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';
import { FILE_STATUS_ENUM } from 'src/shared/minio/enums/file-status-enum';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { MinioService } from 'src/shared/minio/minio.service';
import { HashService } from 'src/shared/hash/hash.service';
import { UserService } from 'src/user/user.service';
import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';
import { SignatureService } from 'src/signature/signature.service';
import { EmailService } from 'src/shared/email/email.service';
import { AuditService } from 'src/audit/audit.service';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import { AccountMemberService } from 'src/account/account-member.service';
import { VerificationCodeService } from './verification-code.service';
import { DocumentTransactionService } from './document-transaction.service';
import { EfirmaService } from 'src/efirma/efirma.service';
import { SealDocumentUseCase } from './seal/use-cases/seal-document.use-case';
import { SendCompletedSimpleSignatureToSealUseCase } from './seal/use-cases/send-completed-simple-signature-to-seal.use-case';
import {} from './summary-document/signature-legal-text';
import { SummaryDocumentService } from './summary-document/summary-document.service';
import { AdvancedSummaryDocumentService } from './summary-document/advanced-summary-document.service';
import { SignatureQrService } from './services/signature-qr.service';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => data),
    // { affected: 1 } por defecto: simula un UPDATE condicional exitoso (ver el claim atómico
    // en sign()/reject()/confirmCancellation()) — los tests que quieren simular una carrera
    // perdida sobreescriben esto explícitamente con { affected: 0 }.
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

describe('DocumentService', () => {
  let service: DocumentService;
  let documentRepository: ReturnType<typeof createMockRepository>;
  let collaboratorRepository: ReturnType<typeof createMockRepository>;
  let minioService: Record<string, jest.Mock>;
  let hashService: Record<string, jest.Mock>;
  let userService: Record<string, jest.Mock>;
  let documentSigningService: Record<string, jest.Mock>;
  let signatureService: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let auditService: Record<string, jest.Mock>;
  let documentEventsProducer: Record<string, jest.Mock>;
  let accountMemberService: Record<string, jest.Mock>;
  let verificationCodeService: Record<string, jest.Mock>;
  let documentTransactionService: Record<string, jest.Mock>;
  let efirmaService: Record<string, jest.Mock>;
  let sealDocumentUseCase: Record<string, jest.Mock>;
  let sendCompletedSimpleSignatureToSeal: Record<string, jest.Mock>;
  let summaryDocumentService: Record<string, jest.Mock>;
  let advancedSummaryDocumentService: Record<string, jest.Mock>;
  let signatureQrService: Record<string, jest.Mock>;

  beforeEach(async () => {
    documentRepository = createMockRepository();
    collaboratorRepository = createMockRepository();
    minioService = {
      uploadObject: jest.fn().mockResolvedValue({
        status: FILE_STATUS_ENUM.FILE_CREATED,
        fileId: 'object-key-1',
      }),
      getFile: jest.fn().mockResolvedValue({
        secureUrl: 'https://minio/file',
        expiresIn: 3600,
      }),
      getFileInBytesFormat: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      uploadPdfAObject: jest.fn().mockResolvedValue(undefined),
      deleteFile: jest.fn(),
      replaceFile: jest.fn(),
    };
    hashService = {
      generateFileHash: jest.fn().mockResolvedValue('hash123'),
      // Alimenta el campo "Cifrado" de la hoja de información de firmas.
      generateCiperHash: jest.fn().mockResolvedValue('cifrado-reversible'),
    };
    userService = {
      findOne: jest.fn().mockResolvedValue({
        id: 'creator-1',
        firstName: 'Creador',
        lastName: 'Uno',
        email: 'creador@correo.com',
      }),
    };
    documentSigningService = {
      getPdfPages: jest.fn().mockResolvedValue(3),
      mergeSignatureIntoPdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      stampRejectedWatermark: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      stampCancelledWatermark: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      appendPdfPages: jest
        .fn()
        .mockResolvedValue(Buffer.from('pdf-con-hoja-anexada')),
      // Página de prueba fija de 600x800pt — suficiente para verificar que la conversión
      // ratio→puntos y el pageIndex correcto llegan a mergeSignatureIntoPdf sin necesitar un
      // PDF real (eso ya lo cubre document-signing.service.spec.ts).
      resolveRatioPosition: jest.fn(async (_buffer: Buffer, position: any) => ({
        pageIndex: position.page - 1,
        coordinates: {
          x: position.xRatio * 600,
          y: 800 - (position.yRatio + position.heightRatio) * 800,
          width: position.widthRatio * 600,
          height: position.heightRatio * 800,
        },
      })),
    };
    signatureService = {
      findOne: jest.fn().mockResolvedValue({
        id: 'signature-1',
        isActive: true,
        signatureObjectKey: 'sig-key',
        officialCardObjectKey: 'ine-key',
      }),
    };
    emailService = {
      sendDocumentPendingNotification: jest.fn(),
      sendDocumentSignedNotification: jest.fn(),
      sendDocumentCompletedToCreatorNotification: jest.fn(),
      sendDocumentRejectedNotification: jest.fn(),
      sendDocumentCancellationPendingNotification: jest.fn(),
      sendDocumentCancelledNotification: jest.fn(),
      sendVerificationCodeNotification: jest.fn(),
    };
    auditService = { create: jest.fn() };
    documentEventsProducer = {
      emitCreated: jest.fn(),
      emitSentToSign: jest.fn(),
      emitCollaboratorSigned: jest.fn(),
      emitSigned: jest.fn(),
      emitRejected: jest.fn(),
      emitCancellationRequested: jest.fn(),
      emitCancelled: jest.fn(),
    };
    accountMemberService = {
      assertIsActiveMember: jest
        .fn()
        .mockResolvedValue({ id: 'account-1', organizationId: null }),
      findPersonalAccountId: jest
        .fn()
        .mockImplementation((userId: string) =>
          Promise.resolve(`account-of-${userId}`),
        ),
    };
    verificationCodeService = {
      issue: jest.fn(),
      verifyAndConsume: jest.fn(),
      hasConsumedCode: jest.fn().mockResolvedValue(true),
      findConsumedCode: jest.fn().mockResolvedValue(null),
    };
    documentTransactionService = {
      createInitial: jest.fn(),
      registerSignature: jest.fn(),
      findAllForDocument: jest.fn().mockResolvedValue([]),
    };
    // Forma REAL de `SignatureResult` (ver src/efirma/interfaces): este mock devolvía un objeto
    // con las llaves en español (firmaBase64/certificado/...) que `EfirmaService.firmar` no
    // produce, así que los tests pasaban contra un contrato inexistente — y lo que se persiste en
    // `advancedSignature` es justo lo que después se le manda a Seal Service.
    efirmaService = {
      firmar: jest.fn().mockReturnValue({
        originalHash: 'hash-doc-1',
        signatureBase64: 'firma-base64',
        algorithm: 'sha256',
        signedAt: new Date('2026-01-01T00:00:00.000Z'),
        certificate: {
          rfc: 'XAXX010101000',
          name: 'Firmante Uno',
          issuer: 'SERVICIO DE ADMINISTRACION TRIBUTARIA',
          serialNumber: '00001000000512345678',
          certificateNumber: '30001000000400002434',
          certificatePem: '-----BEGIN CERTIFICATE-----...',
        },
        // Evidencia de la consulta OCSP al SAT (`OscpService`): forma parte del payload de
        // sellado, así que sin ella la firma se registra pero el sellado nunca sale.
        ocspEvidence: {
          status: 'good',
          verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
          ocspResponse: 'respuesta-ocsp-en-base64',
          ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
        },
      }),
    };
    sealDocumentUseCase = {
      create: jest.fn().mockResolvedValue({ id: 'seal-1' }),
      findByDocumentId: jest.fn().mockResolvedValue(null),
    };
    // Devuelve `false` —"este documento no es asunto suyo"— salvo en las pruebas que lo miran.
    sendCompletedSimpleSignatureToSeal = {
      execute: jest.fn().mockResolvedValue(false),
    };
    summaryDocumentService = {
      generateSummaryPdf: jest
        .fn()
        .mockResolvedValue(Buffer.from('hoja-de-firmas')),
    };
    advancedSummaryDocumentService = {
      generateAdvancedSummaryPdf: jest
        .fn()
        .mockResolvedValue(Buffer.from('hoja-de-firmas-avanzada')),
    };
    signatureQrService = {
      generateAdvancedSignaturePng: jest
        .fn()
        .mockResolvedValue(Buffer.from('qr-png')),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentService,
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: documentRepository,
        },
        {
          provide: getRepositoryToken(CollaboratorEntity),
          useValue: collaboratorRepository,
        },
        { provide: MinioService, useValue: minioService },
        { provide: HashService, useValue: hashService },
        { provide: UserService, useValue: userService },
        { provide: PdfSignatureService, useValue: documentSigningService },
        { provide: SignatureService, useValue: signatureService },
        { provide: EmailService, useValue: emailService },
        { provide: AuditService, useValue: auditService },
        { provide: DocumentEventsProducer, useValue: documentEventsProducer },
        { provide: AccountMemberService, useValue: accountMemberService },
        {
          provide: VerificationCodeService,
          useValue: verificationCodeService,
        },
        {
          provide: DocumentTransactionService,
          useValue: documentTransactionService,
        },
        { provide: EfirmaService, useValue: efirmaService },
        { provide: SealDocumentUseCase, useValue: sealDocumentUseCase },
        {
          provide: SendCompletedSimpleSignatureToSealUseCase,
          useValue: sendCompletedSimpleSignatureToSeal,
        },
        {
          provide: SummaryDocumentService,
          useValue: summaryDocumentService,
        },
        {
          provide: AdvancedSummaryDocumentService,
          useValue: advancedSummaryDocumentService,
        },
        { provide: SignatureQrService, useValue: signatureQrService },
      ],
    }).compile();

    service = module.get<DocumentService>(DocumentService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findOne', () => {
    it('lanza NotFoundException si el documento no existe', async () => {
      documentRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne('missing-doc')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // Historia "Visualización pública de documentos firmados mediante MinIO": esta ruta no tiene
  // ningún control de acceso (cualquiera con el UUID la puede llamar), así que el gate por
  // status === SIGNED es la única defensa contra exponer el archivo de un documento que no
  // debería ser público todavía.
  describe('getDocumentMinioURL: bucket según el estatus del documento', () => {
    it.each([
      // Firmado y con cancelación en curso sirven la versión definitiva (documento + hoja de
      // firmas) desde `finalized_documents` — ver historia "Anexar hoja existente...".
      [DOCUMENT_STATUS_ENUM.SIGNED, BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS],
      [
        DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING,
        BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
      ],
      [DOCUMENT_STATUS_ENUM.REJECTED, BUCKET_TYPES_ENUM.REJECTED_DOCUMENTS],
      [DOCUMENT_STATUS_ENUM.CANCELLED, BUCKET_TYPES_ENUM.CANCELLED_DOCUMENTS],
      [DOCUMENT_STATUS_ENUM.CREATED, BUCKET_TYPES_ENUM.CREATED_DOCUMENTS],
      [DOCUMENT_STATUS_ENUM.PENDING, BUCKET_TYPES_ENUM.CREATED_DOCUMENTS],
      [DOCUMENT_STATUS_ENUM.EXPIRED, BUCKET_TYPES_ENUM.CREATED_DOCUMENTS],
    ])('status=%s resuelve el bucket %s', async (status, expectedBucket) => {
      documentRepository.findOne.mockResolvedValue({
        id: 'doc-1',
        fileName: 'contrato.pdf',
        status,
        objectKey: 'object-key-1',
      });

      await service.getDocumentMinioURL('doc-1');

      expect(minioService.getFile).toHaveBeenCalledWith(
        'object-key-1',
        expectedBucket,
      );
    });

    it('nunca sirve el documento original cuando el documento ya está firmado', async () => {
      documentRepository.findOne.mockResolvedValue({
        id: 'doc-1',
        fileName: 'contrato.pdf',
        status: DOCUMENT_STATUS_ENUM.SIGNED,
        objectKey: 'object-key-1',
      });

      await service.getDocumentMinioURL('doc-1');

      expect(minioService.getFile).not.toHaveBeenCalledWith(
        'object-key-1',
        BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      );
    });

    /**
     * Historia "Actualizar el previsualizador con el avance de firmas": el estatus por sí solo no
     * alcanza para decidir qué versión sirve un documento PENDING — depende de si ya firmó
     * alguien. Es la única excepción a STATUS_BUCKET_MAP.
     */
    it.each([
      [0, BUCKET_TYPES_ENUM.CREATED_DOCUMENTS],
      [undefined, BUCKET_TYPES_ENUM.CREATED_DOCUMENTS],
      [1, BUCKET_TYPES_ENUM.PARTIALLY_SIGNED_DOCUMENTS],
      [3, BUCKET_TYPES_ENUM.PARTIALLY_SIGNED_DOCUMENTS],
    ])(
      'pendiente con completedSignersCount=%s resuelve el bucket %s',
      async (completedSignersCount, expectedBucket) => {
        documentRepository.findOne.mockResolvedValue({
          id: 'doc-1',
          fileName: 'contrato.pdf',
          status: DOCUMENT_STATUS_ENUM.PENDING,
          objectKey: 'object-key-1',
          completedSignersCount,
        });

        await service.getDocumentMinioURL('doc-1');

        expect(minioService.getFile).toHaveBeenCalledWith(
          'object-key-1',
          expectedBucket,
        );
      },
    );

    /**
     * Historia "Descargar documentos usando el nombre del archivo en lugar del ID".
     *
     * La descarga y la previsualización salen de esta misma ruta y sólo se diferencian en el
     * nombre con el que baja el archivo. El nombre lo pone el backend desde `file_name`: es el
     * dato guardado, y así ninguna pantalla puede bautizar el archivo por su cuenta.
     */
    describe('nombre del archivo descargado', () => {
      beforeEach(() => {
        documentRepository.findOne.mockResolvedValue({
          id: 'doc-1',
          fileName: 'Contrato de servicios.pdf',
          status: DOCUMENT_STATUS_ENUM.SIGNED,
          objectKey: 'object-key-1',
        });
      });

      it('con asAttachment, pide el archivo con el nombre del documento', async () => {
        await service.getDocumentMinioURL('doc-1', { asAttachment: true });

        expect(minioService.getFile).toHaveBeenCalledWith(
          'object-key-1',
          BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
          undefined,
          'Contrato de servicios.pdf',
        );
      });

      /**
       * El visor consume esta misma ruta: una cabecera `attachment` haría que el PDF se descargue
       * en lugar de mostrarse dentro de la pantalla de detalle.
       */
      it('sin asAttachment, no manda ningún nombre de descarga', async () => {
        await service.getDocumentMinioURL('doc-1');

        expect(minioService.getFile).toHaveBeenCalledWith(
          'object-key-1',
          BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
        );
      });

      /** El ID es justamente lo que se dejó de usar como nombre visible. */
      it('nunca nombra el archivo con la clave del objeto ni con el ID', async () => {
        await service.getDocumentMinioURL('doc-1', { asAttachment: true });

        const [, , , downloadName] = minioService.getFile.mock.calls.at(-1)!;
        expect(downloadName).not.toBe('object-key-1');
        expect(downloadName).not.toBe('doc-1');
      });
    });

    // La vista previa solo aplica mientras se está firmando: un documento ya firmado, rechazado o
    // cancelado tiene su propia versión definitiva y no debe caer nunca en el bucket de avance.
    it.each([
      DOCUMENT_STATUS_ENUM.SIGNED,
      DOCUMENT_STATUS_ENUM.REJECTED,
      DOCUMENT_STATUS_ENUM.CANCELLED,
    ])('status=%s nunca sirve la vista previa del avance', async (status) => {
      documentRepository.findOne.mockResolvedValue({
        id: 'doc-1',
        fileName: 'contrato.pdf',
        status,
        objectKey: 'object-key-1',
        completedSignersCount: 2,
      });

      await service.getDocumentMinioURL('doc-1');

      expect(minioService.getFile).not.toHaveBeenCalledWith(
        'object-key-1',
        BUCKET_TYPES_ENUM.PARTIALLY_SIGNED_DOCUMENTS,
      );
    });
  });

  /**
   * `GET /document/file/:id` no es la única ruta que entrega el archivo: el detalle
   * (`GET /document/:id`, lo que realmente renderiza el visor de la pantalla de firma) y el
   * listado con `withUrl` traen su propio `secureUrl`. Los tres tienen que resolver el bucket
   * por el mismo STATUS_BUCKET_MAP; si alguno se quedara en el bucket original, un documento ya
   * firmado volvería a mostrarse sin firmas por esa vía aunque `getDocumentMinioURL` esté bien.
   */
  describe('assertUserHasAccess (descarga del archivo)', () => {
    const document = { id: 'doc-1', createdBy: 'creator-1' } as DocumentEntity;

    it('el creador siempre tiene acceso, sin consultar colaboradores', async () => {
      documentRepository.findOne.mockResolvedValue(document);

      await expect(
        service.assertUserHasAccess('doc-1', 'creator-1'),
      ).resolves.toBe(document);
      expect(collaboratorRepository.findOne).not.toHaveBeenCalled();
    });

    it('un colaborador con cuenta vinculada tiene acceso', async () => {
      documentRepository.findOne.mockResolvedValue(document);
      collaboratorRepository.findOne.mockResolvedValue({
        id: 'collaborator-1',
      });

      await expect(
        service.assertUserHasAccess('doc-1', 'user-2'),
      ).resolves.toBe(document);
    });

    it('bug corregido: un colaborador invitado solo por email también puede descargar el archivo (antes 403, con el detalle cargando y el visor vacío)', async () => {
      documentRepository.findOne.mockResolvedValue(document);
      collaboratorRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'collaborator-1', accountId: null });
      userService.findOne.mockResolvedValue({
        id: 'user-2',
        email: 'invitado@correo.com',
      });

      await expect(
        service.assertUserHasAccess('doc-1', 'user-2'),
      ).resolves.toBe(document);
    });

    it('un usuario sin relación con el documento sigue recibiendo ForbiddenException', async () => {
      documentRepository.findOne.mockResolvedValue(document);
      collaboratorRepository.findOne.mockResolvedValue(null);
      userService.findOne.mockResolvedValue({
        id: 'user-3',
        email: 'intruso@correo.com',
      });

      await expect(
        service.assertUserHasAccess('doc-1', 'user-3'),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});

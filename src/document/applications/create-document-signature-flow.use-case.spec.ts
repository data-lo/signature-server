import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { CreateDocumentSignatureFlowUseCase } from './create-document-signature-flow.use-case';
import { DocumentEntity } from '../entities/document.entity';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { NotificationEntity } from '../entities/notification.entity';
import { SimpleSignatureEntity } from 'src/signature/entities/simple-signature.entity';
import { MinioService } from 'src/shared/minio/minio.service';
import { HashService } from 'src/shared/hash/hash.service';
import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';
import { AccountMemberService } from 'src/account/account-member.service';
import { VerificationCodeService } from '../verification-code.service';
import { NotificationEventsProducer } from 'src/kafka/notification-events.producer';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import { EmailService } from 'src/shared/email/email.service';
import { DocumentTransactionService } from '../document-transaction.service';
import { FILE_STATUS_ENUM } from 'src/shared/minio/enums/file-status-enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { ACCOUNT_TYPE_ENUM } from 'src/account/enums/account-type.enum';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import {
  CreateDocumentSignaturesDto,
  PAYLOAD_COLABORATOR_TYPE_ENUM,
  PAYLOAD_SIGNATURE_TYPE_ENUM,
  REQUIRES_DIFFERENT_SIGNATURES_ENUM,
} from '../dto/create-document-signatures.dto';

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

describe('CreateDocumentSignatureFlowUseCase', () => {
  let useCase: CreateDocumentSignatureFlowUseCase;
  let documentRepo: ReturnType<typeof createMockRepository>;
  let collaboratorRepo: ReturnType<typeof createMockRepository>;
  let notificationRepo: ReturnType<typeof createMockRepository>;
  let simpleSignatureRepo: ReturnType<typeof createMockRepository>;
  let dataSource: { transaction: jest.Mock };
  let minioService: Record<string, jest.Mock>;
  let hashService: Record<string, jest.Mock>;
  let documentSigningService: Record<string, jest.Mock>;
  let accountMemberService: Record<string, jest.Mock>;
  let verificationCodeService: Record<string, jest.Mock>;
  let notificationEventsProducer: Record<string, jest.Mock>;
  let documentEventsProducer: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let documentTransactionService: Record<string, jest.Mock>;

  const file = {
    buffer: Buffer.from('%PDF-1.4'),
    originalname: 'contrato.pdf',
    mimetype: 'application/pdf',
    size: 1024,
  } as Express.Multer.File;

  /**
   * Documento de firma SIMPLE (el tipo lo define `documentData`, no cada colaborador — ver
   * historia "Selección de tipo de firma al crear documentos"). Juan trae un `rfc` que el backend
   * debe descartar por ser SIGNER, y María trae requiresTwoFactorAuth:false que el backend debe
   * forzar a true por ser un documento SIMPLE.
   */
  const baseDto: CreateDocumentSignaturesDto = {
    documentData: {
      fileName: 'contrato_prestacion_servicios.pdf',
      signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM.SIMPLE,
    },
    collaborators: [
      {
        collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER,
        firstName: 'Juan',
        lastName: 'Pérez',
        email: 'juan.perez@mail.com',
        rfc: 'PEAJ800101XXX',
        signatures: [
          {
            signatureId: 'sig-1',
            page: 1,
            xRatio: 0.65,
            yRatio: 0.8,
            widthRatio: 0.2,
            heightRatio: 0.08,
          },
        ],
        requiresTwoFactorAuth: true,
      },
      {
        collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER,
        firstName: 'María',
        lastName: 'Gómez',
        email: 'maria.gomez@mail.com',
        rfc: null,
        signatures: [],
        requiresTwoFactorAuth: false, // el backend debe forzarlo a true de todos modos (SIMPLE)
      },
      {
        collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.VIEWER,
        firstName: 'Carlos',
        lastName: 'Solares',
        email: 'auditor@mail.com',
        rfc: 'AUDI990101YYY',
      },
    ],
  };

  /** El mismo documento, pero en el otro (y único) flujo posible: firma electrónica avanzada. */
  const advancedDto: CreateDocumentSignaturesDto = {
    ...baseDto,
    documentData: {
      ...baseDto.documentData,
      signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM.ADVANCED,
    },
  };

  beforeEach(async () => {
    documentRepo = createMockRepository();
    collaboratorRepo = createMockRepository();
    notificationRepo = createMockRepository();
    simpleSignatureRepo = createMockRepository();

    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === DocumentEntity) return documentRepo;
        if (entity === CollaboratorEntity) return collaboratorRepo;
        if (entity === NotificationEntity) return notificationRepo;
        if (entity === SimpleSignatureEntity) return simpleSignatureRepo;
        throw new Error('repositorio no mockeado');
      }),
    };

    dataSource = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) =>
        cb(manager),
      ),
    };

    minioService = {
      uploadObject: jest.fn().mockResolvedValue({
        status: FILE_STATUS_ENUM.FILE_CREATED,
        fileId: 'object-key-1.pdf',
      }),
    };
    hashService = { generateFileHash: jest.fn().mockResolvedValue('hash-123') };
    documentSigningService = { getPdfPages: jest.fn().mockResolvedValue(3) };
    accountMemberService = {
      assertIsActiveMember: jest.fn().mockResolvedValue({
        id: 'account-1',
        accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
        organizationId: null,
      }),
    };
    verificationCodeService = {
      issue: jest.fn().mockResolvedValue({ id: 'vc-1' }),
    };
    notificationEventsProducer = { emitCreated: jest.fn() };
    documentEventsProducer = { emitCreated: jest.fn() };
    emailService = {
      sendDocumentInvitationNotification: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    documentTransactionService = { createInitial: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateDocumentSignatureFlowUseCase,
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
        {
          provide: DocumentEventsProducer,
          useValue: documentEventsProducer,
        },
        { provide: EmailService, useValue: emailService },
        {
          provide: DocumentTransactionService,
          useValue: documentTransactionService,
        },
      ],
    }).compile();

    useCase = module.get<CreateDocumentSignatureFlowUseCase>(
      CreateDocumentSignatureFlowUseCase,
    );
  });

  it('Escenario 1: crea Document + N Collaborators + N Notifications + verification_code y publica N eventos Kafka', async () => {
    const result = await useCase.execute(
      'creator-1',
      'account-1',
      baseDto,
      file,
      '127.0.0.1',
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe(DOCUMENT_STATUS_ENUM.PENDING);
    expect(minioService.uploadObject).toHaveBeenCalled();
    // 2 signers + 1 viewer = 3 colaboradores/notificaciones
    expect(collaboratorRepo.save).toHaveBeenCalledTimes(3);
    expect(notificationRepo.save).toHaveBeenCalledTimes(3);
    expect(result.data.collaboratorsCount).toBe(3);
    // Documento SIMPLE: 2FA forzado en los 2 firmantes = 2 verification_codes
    expect(verificationCodeService.issue).toHaveBeenCalledTimes(2);
    expect(result.data.verificationCodesCount).toBe(2);
    expect(documentRepo.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ requiresVerification: true }),
    );
    expect(notificationEventsProducer.emitCreated).toHaveBeenCalledTimes(3);
    expect(documentEventsProducer.emitCreated).toHaveBeenCalledTimes(1);
    expect(documentEventsProducer.emitCreated).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'creator-1' }),
    );
    expect(documentTransactionService.createInitial).toHaveBeenCalledWith(
      expect.any(String),
      'hash-123',
      expect.anything(),
    );
  });

  it('un documento SIMPLE fuerza verification_code aunque el payload mande requiresTwoFactorAuth:false', async () => {
    const dtoSoloSimpleSinFlag: CreateDocumentSignaturesDto = {
      ...baseDto,
      collaborators: [
        {
          ...baseDto.collaborators[1], // María, requiresTwoFactorAuth: false
        },
      ],
    };

    await useCase.execute(
      'creator-1',
      'account-1',
      dtoSoloSimpleSinFlag,
      file,
      '127.0.0.1',
    );

    expect(verificationCodeService.issue).toHaveBeenCalledTimes(1);
  });

  /**
   * Ver el bug corregido en DocumentService.findWithFilters: mientras el colaborador no tiene
   * cuenta vinculada, su correo es la única identidad con la que el listado "Por firmar" lo
   * empareja — se guarda normalizado, igual que `users.email`.
   */
  it('guarda el correo del colaborador normalizado en minúsculas, no como se tecleó', async () => {
    const dtoConMayusculas: CreateDocumentSignaturesDto = {
      ...advancedDto,
      collaborators: [
        {
          ...advancedDto.collaborators[0],
          email: 'Juan.Perez@Mail.com',
        },
      ],
    };

    await useCase.execute(
      'creator-1',
      'account-1',
      dtoConMayusculas,
      file,
      '127.0.0.1',
    );

    expect(collaboratorRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'juan.perez@mail.com' }),
    );
  });

  it('un documento ADVANCED respeta el requiresTwoFactorAuth de cada firmante', async () => {
    await useCase.execute(
      'creator-1',
      'account-1',
      advancedDto,
      file,
      '127.0.0.1',
    );

    // Solo Juan lo pidió explícitamente; María mandó false y en ADVANCED esa elección se respeta.
    expect(verificationCodeService.issue).toHaveBeenCalledTimes(1);
  });

  it('historia "Selección de tipo de firma": el tipo del documento se copia a todos los firmantes', async () => {
    await useCase.execute(
      'creator-1',
      'account-1',
      advancedDto,
      file,
      '127.0.0.1',
    );

    const signerCalls = collaboratorRepo.create.mock.calls.filter(
      (call) => call[0].colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER,
    );
    expect(signerCalls).toHaveLength(2);
    expect(
      signerCalls.every(
        (call) => call[0].signatureType === SIGNATURE_TYPE_ENUM.FIEL,
      ),
    ).toBe(true);
  });

  it('historia "Selección de tipo de firma": descarta el rfc que venga en un SIGNER (el flujo avanzado lo saca del certificado al firmar)', async () => {
    await useCase.execute(
      'creator-1',
      'account-1',
      advancedDto,
      file,
      '127.0.0.1',
    );

    const juanCall = collaboratorRepo.create.mock.calls.find(
      (call) => call[0].email === 'juan.perez@mail.com',
    );
    // El payload trae rfc: 'PEAJ800101XXX' — un cliente viejo no puede reintroducir el campo.
    expect(juanCall[0].rfc).toBeNull();
  });

  it('rechaza el payload si requiresDifferentSignatures contradice el tipo de firma del documento', async () => {
    const dtoContradictorio: CreateDocumentSignaturesDto = {
      ...baseDto, // documento SIMPLE
      requiresDifferentSignatures: REQUIRES_DIFFERENT_SIGNATURES_ENUM.FIEL,
    };

    await expect(
      useCase.execute(
        'creator-1',
        'account-1',
        dtoContradictorio,
        file,
        '127.0.0.1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(minioService.uploadObject).not.toHaveBeenCalled();
  });

  it('acepta requiresDifferentSignatures cuando coincide con el tipo de firma del documento', async () => {
    const dtoCoherente: CreateDocumentSignaturesDto = {
      ...advancedDto,
      requiresDifferentSignatures: REQUIRES_DIFFERENT_SIGNATURES_ENUM.FIEL,
    };

    const result = await useCase.execute(
      'creator-1',
      'account-1',
      dtoCoherente,
      file,
      '127.0.0.1',
    );

    expect(result.success).toBe(true);
  });

  it('rechaza un documento sin ningún SIGNER: nadie podría firmarlo nunca', async () => {
    const dtoSoloViewer: CreateDocumentSignaturesDto = {
      ...baseDto,
      collaborators: [baseDto.collaborators[2]], // Carlos, VIEWER
    };

    await expect(
      useCase.execute(
        'creator-1',
        'account-1',
        dtoSoloViewer,
        file,
        '127.0.0.1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(minioService.uploadObject).not.toHaveBeenCalled();
  });

  it('bug corregido: asigna signingOrder consecutivo (0,1,2...) solo entre los SIGNER, en el orden del payload; VIEWER queda en null', async () => {
    await useCase.execute('creator-1', 'account-1', baseDto, file, '127.0.0.1');

    const juanCall = collaboratorRepo.create.mock.calls.find(
      (call) => call[0].email === 'juan.perez@mail.com',
    );
    const mariaCall = collaboratorRepo.create.mock.calls.find(
      (call) => call[0].email === 'maria.gomez@mail.com',
    );
    const carlosCall = collaboratorRepo.create.mock.calls.find(
      (call) => call[0].email === 'auditor@mail.com',
    );

    expect(juanCall[0].signingOrder).toBe(0);
    expect(mariaCall[0].signingOrder).toBe(1);
    expect(carlosCall[0].signingOrder).toBeNull();
  });

  it('historia "Habilitar ordenamiento Drag and Drop": cuando todos los colaboradores traen orderIndex, signingOrder respeta ese orden en vez del orden de aparición en el payload', async () => {
    const dtoConOrderIndexInvertido: CreateDocumentSignaturesDto = {
      ...baseDto,
      collaborators: baseDto.collaborators.map((c, index) => ({
        ...c,
        // Invierte el orden visual: María (payload index 1) debe firmar primero,
        // Juan (payload index 0) segundo — Carlos (VIEWER) no firma, su orderIndex es irrelevante.
        orderIndex: baseDto.collaborators.length - 1 - index,
      })),
    };

    await useCase.execute(
      'creator-1',
      'account-1',
      dtoConOrderIndexInvertido,
      file,
      '127.0.0.1',
    );

    const juanCall = collaboratorRepo.create.mock.calls.find(
      (call) => call[0].email === 'juan.perez@mail.com',
    );
    const mariaCall = collaboratorRepo.create.mock.calls.find(
      (call) => call[0].email === 'maria.gomez@mail.com',
    );

    expect(mariaCall[0].signingOrder).toBe(0);
    expect(juanCall[0].signingOrder).toBe(1);
  });

  it('documento secuencial (default, sin isSequential en el payload): no envía invitaciones de firma simple', async () => {
    await useCase.execute('creator-1', 'account-1', baseDto, file, '127.0.0.1');

    expect(
      emailService.sendDocumentInvitationNotification,
    ).not.toHaveBeenCalled();
    const savedDocumentCall = documentRepo.save.mock.calls[0][0];
    expect(savedDocumentCall.isSequential).toBe(true);
  });

  it('documento SIMPLE sin orden (isSequential:false): invita por correo a los firmantes, no al viewer', async () => {
    const dtoSinOrden: CreateDocumentSignaturesDto = {
      ...baseDto,
      documentData: { ...baseDto.documentData, isSequential: false },
    };

    await useCase.execute(
      'creator-1',
      'account-1',
      dtoSinOrden,
      file,
      '127.0.0.1',
    );

    const savedDocumentCall = documentRepo.save.mock.calls[0][0];
    expect(savedDocumentCall.isSequential).toBe(false);
    // Los 2 SIGNER, ninguno para Carlos (VIEWER).
    expect(
      emailService.sendDocumentInvitationNotification,
    ).toHaveBeenCalledTimes(2);
    expect(
      emailService.sendDocumentInvitationNotification,
    ).toHaveBeenCalledWith(
      'maria.gomez@mail.com',
      'María Gómez',
      dtoSinOrden.documentData.fileName,
      expect.stringContaining('/access-document?docId='),
    );
  });

  it('documento ADVANCED sin orden: no manda la invitación de firma simple a nadie', async () => {
    const dtoAvanzadoSinOrden: CreateDocumentSignaturesDto = {
      ...advancedDto,
      documentData: { ...advancedDto.documentData, isSequential: false },
    };

    await useCase.execute(
      'creator-1',
      'account-1',
      dtoAvanzadoSinOrden,
      file,
      '127.0.0.1',
    );

    expect(
      emailService.sendDocumentInvitationNotification,
    ).not.toHaveBeenCalled();
  });

  it('un fallo al enviar la invitación no tumba la creación del documento', async () => {
    emailService.sendDocumentInvitationNotification.mockRejectedValue(
      new Error('SendGrid caído'),
    );
    const dtoSinOrden: CreateDocumentSignaturesDto = {
      ...baseDto,
      documentData: { ...baseDto.documentData, isSequential: false },
    };

    const result = await useCase.execute(
      'creator-1',
      'account-1',
      dtoSinOrden,
      file,
      '127.0.0.1',
    );

    expect(result.success).toBe(true);
  });

  it('el viewer se crea con colaboratorType WATCHER, sin signatureType ni verification_code', async () => {
    await useCase.execute('creator-1', 'account-1', baseDto, file, '127.0.0.1');

    const viewerCall = collaboratorRepo.create.mock.calls.find(
      (call) => call[0].email === 'auditor@mail.com',
    );
    expect(viewerCall[0].colaboratorType).toBe(COLABORATOR_TYPE_ENUM.WATCHER);
    expect(viewerCall[0].signatureType).toBeNull();
    expect(viewerCall[0].rfc).toBe('AUDI990101YYY');
    // Solo 2 verification_codes en total (los 2 signers), ninguno para el viewer.
    expect(verificationCodeService.issue).toHaveBeenCalledTimes(2);
  });

  it('crea una SimpleSignatureEntity por firmante, incluso con un arreglo vacío de posiciones', async () => {
    await useCase.execute('creator-1', 'account-1', baseDto, file, '127.0.0.1');

    // Juan (signatures con 1 elemento) y María (signatures: []) — ambos SIGNER, ambos deben
    // recibir una fila propia (ver historia "Ubicación de firmas por usuario": simpleSignatureId
    // asignado, con o sin posiciones, distingue a estos colaboradores del flujo /document viejo).
    expect(simpleSignatureRepo.save).toHaveBeenCalledTimes(2);
    expect(simpleSignatureRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        signatureCoordinates: [
          expect.objectContaining({
            signatureId: 'sig-1',
            page: 1,
            xRatio: 0.65,
            yRatio: 0.8,
            widthRatio: 0.2,
            heightRatio: 0.08,
          }),
        ],
      }),
    );
    expect(simpleSignatureRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ signatureCoordinates: [] }),
    );
  });

  it('bug corregido: rechaza con BadRequestException si dos firmantes colocan una posición que se solapa en la misma página', async () => {
    const dtoConColision: CreateDocumentSignaturesDto = {
      ...baseDto,
      collaborators: baseDto.collaborators.map((collaborator) =>
        collaborator.email === 'maria.gomez@mail.com'
          ? {
              ...collaborator,
              signatures: [
                {
                  signatureId: 'sig-2',
                  page: 1,
                  xRatio: 0.7,
                  yRatio: 0.82,
                  widthRatio: 0.2,
                  heightRatio: 0.08,
                },
              ],
            }
          : collaborator,
      ),
    };

    await expect(
      useCase.execute(
        'creator-1',
        'account-1',
        dtoConColision,
        file,
        '127.0.0.1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(simpleSignatureRepo.save).not.toHaveBeenCalled();
  });

  it('Escenario 2: si falla la inserción dentro de la transacción, no se publica ningún evento a Kafka', async () => {
    collaboratorRepo.save.mockRejectedValueOnce(new Error('DB caída'));

    await expect(
      useCase.execute('creator-1', 'account-1', baseDto, file, '127.0.0.1'),
    ).rejects.toThrow('DB caída');

    expect(notificationEventsProducer.emitCreated).not.toHaveBeenCalled();
    expect(documentEventsProducer.emitCreated).not.toHaveBeenCalled();
  });

  it('rechaza con BadRequestException si no se proporciona archivo', async () => {
    await expect(
      useCase.execute(
        'creator-1',
        'account-1',
        baseDto,
        undefined as unknown as Express.Multer.File,
        '127.0.0.1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(minioService.uploadObject).not.toHaveBeenCalled();
  });

  it('rechaza con BadRequestException si falta el header X-Account-Id', async () => {
    await expect(
      useCase.execute(
        'creator-1',
        undefined as unknown as string,
        baseDto,
        file,
        '127.0.0.1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(accountMemberService.assertIsActiveMember).not.toHaveBeenCalled();
  });

  it('documentData.requiresApproval se guarda en el documento cuando la cuenta activa es ORGANIZATION', async () => {
    accountMemberService.assertIsActiveMember.mockResolvedValue({
      id: 'account-1',
      accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
      organizationId: 'org-1',
    });
    const dtoConAprobacion: CreateDocumentSignaturesDto = {
      ...baseDto,
      documentData: { ...baseDto.documentData, requiresApproval: true },
    };

    await useCase.execute(
      'creator-1',
      'account-1',
      dtoConAprobacion,
      file,
      '127.0.0.1',
    );

    expect(documentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ requiresApproval: true }),
    );
  });

  it('bug corregido: rechaza requiresApproval=true cuando la cuenta activa es PERSONAL', async () => {
    // El mock por defecto de assertIsActiveMember ya es PERSONAL (ver beforeEach).
    const dtoConAprobacion: CreateDocumentSignaturesDto = {
      ...baseDto,
      documentData: { ...baseDto.documentData, requiresApproval: true },
    };

    await expect(
      useCase.execute(
        'creator-1',
        'account-1',
        dtoConAprobacion,
        file,
        '127.0.0.1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(documentRepo.create).not.toHaveBeenCalled();
  });

  it('no rechaza una cuenta PERSONAL cuando requiresApproval no se solicita', async () => {
    await useCase.execute('creator-1', 'account-1', baseDto, file, '127.0.0.1');

    expect(documentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ requiresApproval: false }),
    );
  });
});

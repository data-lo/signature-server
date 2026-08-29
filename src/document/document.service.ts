// NestJS core
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

// TypeORM
import { FindOptionsRelations, ILike, IsNull, Repository } from 'typeorm';

// Entities
import { DocumentEntity } from './entities/document.entity';
import { CollaboratorEntity } from './entities/collaborator.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';

// DTOs

// Enums
import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';
import { COLABORATOR_TYPE_ENUM } from './enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from './enum/signee-status.enum';
import { SIGNATURE_TYPE_ENUM } from './enum/signature-type.enum';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';

// Interfaces & payloads
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { DEFAULT_COORDINATES } from 'src/shared/document-signing/interfaces/default-signing-coordinates.interface';
import { SignatureCoordinates } from 'src/shared/document-signing/interfaces/signature-coordinates.interface';
import type {
  LegacySignatureCoordinates,
  SignaturePositionRecord,
} from 'src/signature/entities/simple-signature.entity';

// Services
import { MinioService } from '../shared/minio/minio.service';
import { HashService } from '../shared/hash/hash.service';
import { UserService } from '../user/user.service';
import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';
import { SignatureService } from 'src/signature/signature.service';
import { EmailService } from 'src/shared/email/email.service';
import { AuditService } from 'src/audit/audit.service';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import { PublicSignerData } from './interfaces/responses/document-public-view-response';
import { AccountMemberService } from 'src/account/account-member.service';
import { getNextPendingSigner } from './utils/next-signer.util';
import {
  collaboratorDisplayName,
  collaboratorEmail,
} from './utils/collaborator-display.util';
import { isAdvancedSignatureDocument } from './utils/advanced-signature-document.util';
import { toIsoStringOrNull } from './utils/iso-date.util';
import {
  buildAdvancedSignatureUrl,
  buildAllDocumentsUrl,
  buildDocumentAccessUrl,
  buildPublicDocumentUrl,
} from './utils/document-access-url.util';
import {
  SignatureQrService,
  type AdvancedSignatureQrData,
} from './services/signature-qr.service';
import { VerificationCodeService } from './verification-code.service';
import { VERIFICATION_EVENT_ENUM } from './enum/verification-event.enum';
import { MAX_EFIRMA_FILE_SIZE_BYTES } from 'src/shared/constants/file-upload.constants';
import { DocumentTransactionService } from './document-transaction.service';
import { EfirmaService } from 'src/efirma/efirma.service';
import type { SignatureResult } from 'src/efirma/interfaces/signature-result.interface';
import { SealDocumentUseCase } from './seal/use-cases/seal-document.use-case';
import { SendCompletedSimpleSignatureToSealUseCase } from './seal/use-cases/send-completed-simple-signature-to-seal.use-case';
import { SummaryDocumentService } from './summary-document/summary-document.service';
import { AdvancedSummaryDocumentService } from './summary-document/advanced-summary-document.service';
import type { SummaryDocumentSigner } from './summary-document/interfaces/summary-document.interface';
import type { AdvancedSummaryDocumentSigner } from './summary-document/interfaces/advanced-summary-document.interface';
import type { SealDocumentDto } from './seal/dto/seal-document.dto';
import { SealEntity } from './seal/entities/seal.entity';
import { DocumentAlreadySealedException } from './seal/exceptions/seal.exceptions';
import { toConservationRecord } from './summary-document/conservation-record.util';
import {
  ADVANCED_SIGNATURE_BACKING_LABEL,
  ADVANCED_SIGNATURE_TYPE_LABEL,
  SIMPLE_SIGNATURE_BACKING_LABEL,
  SIMPLE_SIGNATURE_TYPE_LABEL,
} from './summary-document/signature-legal-text';
import {} from './seal/seal-artifacts';

const SIGNATURE_STAMP_VERTICAL_GAP = 40;

/** .key/.cer suben por separado como multipart (no forman parte de SignDocumentDto). */
export interface AdvancedSignatureInput {
  password?: string;
  keyFile?: Express.Multer.File;
  cerFile?: Express.Multer.File;
}

/**
 * Distingue una posición en el shape nuevo (ratios 0-1, ver historia "Ubicación de firmas por
 * usuario") de una en el shape legacy (píxeles absolutos, pre-migración
 * `ArraySignatureCoordinates`) dentro del mismo arreglo `signatureCoordinates`.
 */
function isRatioSignaturePosition(
  position: SignaturePositionRecord | LegacySignatureCoordinates,
): position is SignaturePositionRecord {
  return 'xRatio' in position;
}

/**
 * Capacidades reutilizables del dominio de documentos.
 *
 * Acá no vive ningún flujo de endpoint: cada acción de negocio —crear, enviar a autorización,
 * firmar, rechazar, cancelar— es un caso de uso de `applications/`, y lo que queda en este
 * servicio son las piezas que esos casos de uso comparten:
 *
 *  - resolver documentos y colaboradores (`findOne`, `resolveMyCollaborator`,
 *    `findOrLinkMySignerCollaborator`, `findMySignerCollaborator`),
 *  - decidir el acceso y el bucket de cada archivo (`assertUserHasAccess`,
 *    `resolveDocumentBucket`, `getDocumentMinioURL`),
 *  - firmar con e.firma y congelar la rúbrica del momento (`validateAndSignWithEfirma`,
 *    `snapshotSignatureImage`),
 *  - estampar el PDF, anexar la hoja de firmas y sellar con el PSC (`stampSignaturesOnto`,
 *    `attachSignaturesSheet`, `finalizeSignedDocument`, `sealAdvancedSignatures`),
 *  - avisar por correo (`notifyNextSigner`, `sendCompletionEmails`).
 *
 * Varias de ellas las usa más de un caso de uso —`findOrLinkMySignerCollaborator` la comparten
 * firmar y rechazar; `notifyNextSigner`, enviar a autorización y firmar—, y por eso viven acá y
 * no dentro de ninguno de ellos.
 */
@Injectable()
export class DocumentService {
  logger = new Logger(DocumentService.name);

  private readonly STATUS_BUCKET_MAP: Record<
    DOCUMENT_STATUS_ENUM,
    BUCKET_TYPES_ENUM
  > = {
    [DOCUMENT_STATUS_ENUM.CANCELLED]: BUCKET_TYPES_ENUM.CANCELLED_DOCUMENTS,
    [DOCUMENT_STATUS_ENUM.REJECTED]: BUCKET_TYPES_ENUM.REJECTED_DOCUMENTS,
    // Una vez firmado, lo que se sirve es la versión definitiva —documento + hoja de información
    // de firmas— y no la copia de `signed_documents`, que existe solo como insumo interno del
    // `signedHash` (ver `attachSignaturesSheet`). CANCELLATION_PENDING es un estado posterior a la
    // firma, así que muestra esa misma versión mientras se resuelve la solicitud de cancelación.
    [DOCUMENT_STATUS_ENUM.SIGNED]: BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
    [DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING]:
      BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
    [DOCUMENT_STATUS_ENUM.PENDING]: BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
    [DOCUMENT_STATUS_ENUM.CREATED]: BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
    [DOCUMENT_STATUS_ENUM.EXPIRED]: BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
  };

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly minioService: MinioService,
    private readonly hashService: HashService,
    private readonly userService: UserService,
    private readonly documentSigningSerivice: PdfSignatureService,
    private readonly signatureService: SignatureService,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
    private readonly documentEventsProducer: DocumentEventsProducer,
    private readonly accountMemberService: AccountMemberService,
    private readonly verificationCodeService: VerificationCodeService,
    private readonly documentTransactionService: DocumentTransactionService,
    private readonly efirmaService: EfirmaService,
    private readonly sealDocumentUseCase: SealDocumentUseCase,
    private readonly sendCompletedSimpleSignatureToSeal: SendCompletedSimpleSignatureToSealUseCase,
    private readonly summaryDocumentService: SummaryDocumentService,
    private readonly advancedSummaryDocumentService: AdvancedSummaryDocumentService,
    private readonly signatureQrService: SignatureQrService,
  ) {}

  async getCollaboratorNames(documentId: string): Promise<{
    signers: string[];
    watchers: string[];
    reviewers: string[];
  }> {
    const collaborators = await this.collaboratorRepository.find({
      where: { documentId },
      relations: { account: { user: true } },
      order: { signingOrder: 'ASC' },
    });

    const byType = (type: COLABORATOR_TYPE_ENUM) =>
      collaborators
        .filter((c) => c.colaboratorType === type)
        .map(collaboratorDisplayName);

    return {
      signers: byType(COLABORATOR_TYPE_ENUM.SIGNER),
      watchers: byType(COLABORATOR_TYPE_ENUM.WATCHER),
      reviewers: byType(COLABORATOR_TYPE_ENUM.REVIEWER),
    };
  }

  /**
   * Tipo de firma del documento (`simple` / `fiel`) para el listado, o `null` si no se puede
   * determinar — lo consume la columna "Tipo de firma" de las tablas del frontend.
   *
   * El tipo no vive en `DocumentEntity` sino en cada SIGNER: es una decisión del documento que
   * `CreateDocumentSignatureFlowUseCase` copia igual a todos sus firmantes al crearlo, así que basta con
   * mirarlos. Los colaboradores ya vienen en el mismo query del listado, así que esto no agrega
   * ninguna consulta.
   *
   * Se exige que todos coincidan en vez de tomar el primero: los documentos del endpoint viejo
   * (`POST /document`) nunca asignaron tipo, y un `null` explícito es información honesta —el
   * frontend muestra un guion— mientras que el tipo del primer firmante sería una suposición.
   */
  resolveDocumentSignatureType(
    collaborators: CollaboratorEntity[] | undefined,
  ): SIGNATURE_TYPE_ENUM | null {
    const signatureTypes = new Set(
      (collaborators ?? [])
        .filter((c) => c.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER)
        .map((c) => c.signatureType)
        .filter((type): type is SIGNATURE_TYPE_ENUM => Boolean(type)),
    );

    return signatureTypes.size === 1 ? [...signatureTypes][0] : null;
  }

  /**
   * Colaborador que corresponde al usuario autenticado dentro de un documento, para operaciones
   * de LECTURA.
   *
   * Se resuelve primero por cuenta vinculada y, si no hay, por email (case-insensitive) contra
   * las invitaciones que todavía no tienen `accountId`.
   *
   * Bug corregido: solo se emparejaba por `accountId`, pero ese campo permanece en null hasta que
   * el firmante entra por el enlace del correo (`/access-document` → linkPendingCollaboratorAccount).
   * Como el listado (`GET /document?participantEmail=`) sí filtra por email, el usuario veía en
   * "Por firmar" documentos que el detalle le rechazaba con 403 — quedaba atascado si llegaba por
   * la navegación en vez del correo. Emparejar por email aquí no amplía el modelo de seguridad:
   * `sign()`/`reject()` ya identifican al firmante exactamente así (ver
   * findOrLinkMySignerCollaborator), y el email de la cuenta está verificado por OTP en el
   * registro.
   *
   * Sigue sin vincular nada (ver historia "Vinculación del documento debe postergarse hasta el
   * inicio de sesión y validación de RFC"): una lectura no puede tener el efecto secundario de
   * asociar la cuenta: eso sigue siendo una acción explícita de AccessDocumentView/useLogin, o
   * perezosa dentro de sign()/reject().
   */
  async resolveMyCollaborator(
    collaborators: CollaboratorEntity[],
    currentUserId: string,
  ): Promise<CollaboratorEntity | undefined> {
    const linked = collaborators.find(
      (c) => c.account?.userId === currentUserId,
    );
    if (linked) {
      return linked;
    }

    const pendingInvitations = collaborators.filter((c) => !c.accountId);
    if (pendingInvitations.length === 0) {
      return undefined;
    }

    const user = await this.userService.findOne(currentUserId);
    const userEmail = user.email?.toLowerCase();

    return pendingInvitations.find(
      (c) => Boolean(c.email) && c.email!.toLowerCase() === userEmail,
    );
  }

  /**
   * Vincula al usuario autenticado como Collaborator de un documento al que fue invitado solo
   * por email (accountId todavía null) — ver historia "Notificación por Email para Firma
   * Simple y Vinculación de Cuenta". Empareja por email (case-insensitive) porque, mientras el
   * colaborador no tiene accountId, el email es la única señal disponible para identificarlo.
   *
   * Dos callers:
   *  - PATCH /document/:id/link-collaborator (Casos B/C: recién completado registro/login desde
   *    el enlace del correo, el frontend lo llama explícitamente antes de redirigir al documento).
   *  - sign() (Caso A: sesión ya activa al llegar desde el enlace — vinculación perezosa).
   *
   * No lanza si no hay nada que vincular (`linked: false`): no tener una invitación pendiente
   * con ese email no es un error, es el caso normal para cualquier documento sin este flujo.
   */
  async linkPendingCollaboratorAccount(
    documentId: string,
    currentUserId: string,
  ): Promise<BaseResponse<{ linked: boolean }>> {
    const user = await this.userService.findOne(currentUserId);

    const collaborator = await this.collaboratorRepository.findOne({
      where: {
        documentId,
        email: ILike(user.email),
        accountId: IsNull(),
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      },
    });

    if (!collaborator) {
      return {
        success: true,
        message: 'No hay ninguna invitación pendiente para vincular',
        data: { linked: false },
      };
    }

    const accountId =
      await this.accountMemberService.findPersonalAccountId(currentUserId);
    await this.collaboratorRepository.update(collaborator.id, { accountId });

    return {
      success: true,
      message: 'Cuenta vinculada correctamente al documento',
      data: { linked: true },
    };
  }

  /**
   * Resuelve `myParticipant` (+ el arreglo completo de firmantes) para un documento, e intenta
   * vincular al usuario autenticado por email si todavía no aparece como colaborador — Caso A de
   * "Notificación por Email para Firma Simple y Vinculación de Cuenta": llegó ya autenticado
   * desde el enlace del correo, con su fila de Collaborator aún sin accountId.
   *
   * Bug corregido: antes solo sign() tenía este comportamiento — reject() (y por extensión
   * cualquier firmante que llegara ya autenticado y su primera acción fuera rechazar, no firmar)
   * se topaba con un ForbiddenException aunque su email sí coincidiera con una invitación
   * pendiente. Compartir esta resolución entre ambos flujos cierra esa asimetría.
   */
  async findOrLinkMySignerCollaborator(
    documentId: string,
    currentUserId: string,
    relations: FindOptionsRelations<CollaboratorEntity>,
  ): Promise<{
    signerCollaborators: CollaboratorEntity[];
    myParticipant: CollaboratorEntity | undefined;
  }> {
    let signerCollaborators = await this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      relations,
      order: { signingOrder: 'ASC' },
    });

    let myParticipant = signerCollaborators.find(
      (c) => c.account?.userId === currentUserId,
    );

    if (!myParticipant) {
      const linkResult = await this.linkPendingCollaboratorAccount(
        documentId,
        currentUserId,
      );
      if (linkResult.data.linked) {
        signerCollaborators = await this.collaboratorRepository.find({
          where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
          relations,
          order: { signingOrder: 'ASC' },
        });
        myParticipant = signerCollaborators.find(
          (c) => c.account?.userId === currentUserId,
        );
      }
    }

    return { signerCollaborators, myParticipant };
  }

  /**
   * Bucket del que se sirve un documento. Es `STATUS_BUCKET_MAP` más la única excepción que el
   * estatus por sí solo no alcanza a expresar: un documento PENDING en el que ya firmó alguien se
   * sirve desde la vista previa con esas firmas estampadas, no desde el original (historia
   * "Actualizar el previsualizador con el avance de firmas"). Mientras no haya firmado nadie no
   * existe vista previa que servir, así que sigue el original.
   *
   * Toda ruta de lectura pasa por acá para que no puedan discrepar entre sí sobre qué versión del
   * archivo le corresponde a un documento.
   */
  resolveDocumentBucket(document: {
    status: DOCUMENT_STATUS_ENUM;
    completedSignersCount?: number | null;
  }): BUCKET_TYPES_ENUM {
    if (
      document.status === DOCUMENT_STATUS_ENUM.PENDING &&
      (document.completedSignersCount ?? 0) > 0
    ) {
      return BUCKET_TYPES_ENUM.PARTIALLY_SIGNED_DOCUMENTS;
    }

    return (
      this.STATUS_BUCKET_MAP[document.status] ??
      BUCKET_TYPES_ENUM.CREATED_DOCUMENTS
    );
  }

  /** Genera y retorna la URL segura del archivo en Minio según el estatus del documento. */
  async getDocumentMinioURL(documentId: string) {
    try {
      const document = await this.findOne(documentId);
      const bucket = this.resolveDocumentBucket(document);
      const fileResponse = await this.minioService.getFile(
        document.objectKey,
        bucket,
      );
      return fileResponse;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new Error(`Error obteniendo URL del Documento: ${error}`);
    }
  }

  /**
   * Firmante de un documento TODAVÍA PENDIENTE: solo su nombre. Los demás campos van en null a
   * propósito y no se omiten del objeto, para que el frontend tenga una sola forma que renderizar
   * en los dos estados.
   */
  toPendingPublicSigner(collaborator: CollaboratorEntity): PublicSignerData {
    return {
      id: collaborator.id,
      name: collaboratorDisplayName(collaborator),
      signatureType: null,
      signatureTypeLabel: '',
      legalBacking: '',
      ipAddress: '',
      signedAt: null,
      otpCode: null,
      certificateSerialNumber: null,
      electronicSignature: null,
    };
  }

  /**
   * Firmante de un documento COMPLETADO, con la evidencia que corresponde a su tipo de firma.
   *
   * Es la misma evidencia que ya imprime la hoja de firmas anexada al PDF (ver `toSummarySigner` /
   * `toAdvancedSummarySigner`), campo por campo — esta pantalla es la versión consultable de esa
   * hoja, no una segunda fuente de verdad con criterios propios.
   *
   * Los campos exclusivos del otro tipo se devuelven en `null`, nunca en cadena vacía: es lo que
   * permite al frontend ocultar el renglón entero en vez de pintarlo sin valor.
   *
   * La geolocalización del firmante ya no viaja en esta respuesta (historia "Ocultar
   * geolocalización en hojas de firma y vistas públicas", ver `PublicSignerData`): la hoja dejó de
   * imprimirla y esta ruta —que abre cualquiera con el id, sin sesión— era el último lugar donde
   * seguía publicándose. Se sigue guardando en `collaborator.geoLoc` como evidencia.
   */
  async toCompletedPublicSigner(
    documentId: string,
    collaborator: CollaboratorEntity,
  ): Promise<PublicSignerData> {
    const advancedSignature = collaborator.advancedSignature;

    if (collaborator.signatureType === SIGNATURE_TYPE_ENUM.FIEL) {
      return {
        id: collaborator.id,
        // El nombre del certificado es el que el SAT tiene registrado para ese RFC — mismo criterio
        // que `getAdvancedSignaturePublicView` y que la hoja de evidencia avanzada.
        name:
          advancedSignature?.certificate?.name ??
          collaboratorDisplayName(collaborator),
        signatureType: SIGNATURE_TYPE_ENUM.FIEL,
        signatureTypeLabel: ADVANCED_SIGNATURE_TYPE_LABEL,
        legalBacking: ADVANCED_SIGNATURE_BACKING_LABEL,
        ipAddress: collaborator.ipAddress,
        // `advancedSignature.signedAt` es el momento real del firmado criptográfico; el del
        // colaborador es cuándo se registró en la base y solo sirve de respaldo.
        signedAt: toIsoStringOrNull(
          advancedSignature?.signedAt ?? collaborator.signedAt,
        ),
        otpCode: null,
        certificateSerialNumber:
          advancedSignature?.certificate?.serialNumber ?? null,
        electronicSignature: advancedSignature
          ? String(advancedSignature.signatureBase64)
          : null,
      };
    }

    return {
      id: collaborator.id,
      name: collaboratorDisplayName(collaborator),
      signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
      signatureTypeLabel: SIMPLE_SIGNATURE_TYPE_LABEL,
      legalBacking: SIMPLE_SIGNATURE_BACKING_LABEL,
      ipAddress: collaborator.ipAddress,
      signedAt: toIsoStringOrNull(collaborator.signedAt),
      // Evidencia de con qué código se acreditó su identidad. No siempre existe: la verificación
      // por OTP depende de `document.requiresVerification`, así que un documento que no la exigió
      // se completa sin código y el renglón simplemente no se muestra.
      otpCode: await this.verificationCodeService.findConsumedCode(
        documentId,
        collaborator.id,
        VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
      ),
      certificateSerialNumber: null,
      electronicSignature: null,
    };
  }

  /** Busca un documento por su UUID y lanza NotFoundException si no existe. */
  async findOne(documentId: string): Promise<DocumentEntity> {
    const document = await this.documentRepository.findOne({
      where: { id: documentId },
    });
    if (!document) {
      throw new NotFoundException(
        `El documento con id ${documentId} no se encuentra`,
      );
    }
    return document;
  }

  /**
   * Verifica si el usuario tiene acceso al documento (creador o colaborador). Usado para proteger
   * la descarga del archivo.
   *
   * Mismo criterio que `resolveMyCollaborator`: por cuenta vinculada o, si la invitación sigue
   * pendiente de vincular, por email. Sin esto la pantalla de detalle cargaba pero el archivo
   * no (el visor pedía `/document/file/:id` y recibía 403), dejando la firma a medias.
   */
  async assertUserHasAccess(
    documentId: string,
    userId: string,
  ): Promise<DocumentEntity> {
    const document = await this.findOne(documentId);
    if (document.createdBy === userId) {
      return document;
    }

    const linkedCollaborator = await this.collaboratorRepository.findOne({
      where: { documentId, account: { userId } },
    });
    if (linkedCollaborator) {
      return document;
    }

    const user = await this.userService.findOne(userId);
    const invitedCollaborator = user.email
      ? await this.collaboratorRepository.findOne({
          where: {
            documentId,
            accountId: IsNull(),
            email: ILike(user.email),
          },
        })
      : null;
    if (!invitedCollaborator) {
      throw new ForbiddenException('No tienes acceso a este documento');
    }

    return document;
  }

  /** Envía el correo de solicitud de firma al siguiente firmante pendiente en el orden establecido. */
  async notifyNextSigner(documentId: string): Promise<void> {
    const signerCollaborators = await this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      relations: { account: { user: true } },
    });
    const nextSigner = getNextPendingSigner(signerCollaborators);

    if (!nextSigner) return;

    const document = await this.findOne(documentId);
    const creator = await this.userService.findOne(document.createdBy);
    const signerEmail = collaboratorEmail(nextSigner);

    await this.emailService.sendDocumentPendingNotification(
      signerEmail,
      collaboratorDisplayName(nextSigner),
      creator.email,
      document.fileName,
      buildDocumentAccessUrl(documentId, nextSigner.id, signerEmail),
      buildAllDocumentsUrl(),
    );
  }

  /**
   * Puerta de la firma Simple: sólo se puede firmar con `signingCredentialStatus` en CONFIGURED.
   *
   * Antes se comprobaba a mano que el usuario tuviera `signatureId` y que su fila de `signatures`
   * tuviera la rúbrica y la identificación cargadas. Eso reconstruía, mal y por separado, lo que
   * `signingCredentialStatus` ya sabe: una firma PNG subida no dice nada sobre si la identidad
   * del firmante quedó validada, así que un usuario con la rúbrica puesta pero con la
   * verificación rechazada pasaba este control. La credencial es una sola variable y ésta es la
   * única pregunta que hay que hacerle.
   *
   * No aplica a la firma avanzada: quien firma con e.firma acredita su identidad con el
   * certificado del SAT, y su equivalente es `validateAndSignWithEfirma`.
   */
  assertCanSignWithSimpleSignature(user: UserEntity): void {
    if (
      user.signingCredentialStatus === SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED
    ) {
      return;
    }

    throw new BadRequestException(
      'Es necesario configurar tu identidad y firma para poder firmar con firma Simple.',
    );
  }

  /**
   * Valida el `.key`/`.cer`/contraseña de e.firma del firmante FIEL y ejecuta la firma
   * criptográfica sobre el documento actual. Delega toda la validación real (contraseña,
   * vigencia del certificado, cadena de confianza SAT, correspondencia llave/certificado) a
   * `EfirmaService.firmar` — este servicio nunca se expone como endpoint independiente, solo se
   * invoca aquí. Los errores de `EfirmaService` (422, mensajes claros en español) se propagan
   * tal cual, sin envolverlos.
   */
  async validateAndSignWithEfirma(
    document: DocumentEntity,
    input: AdvancedSignatureInput | undefined,
  ): Promise<SignatureResult> {
    const { password, keyFile, cerFile } = input ?? {};

    if (!keyFile) {
      throw new BadRequestException(
        'Falta el archivo de la llave privada (.key)',
      );
    }
    if (!cerFile) {
      throw new BadRequestException('Falta el archivo del certificado (.cer)');
    }
    if (!password) {
      throw new BadRequestException('Falta la contraseña de la llave privada');
    }
    if (!keyFile.originalname.toLowerCase().endsWith('.key')) {
      throw new BadRequestException(
        'El archivo de la llave privada debe tener extensión .key',
      );
    }
    if (!cerFile.originalname.toLowerCase().endsWith('.cer')) {
      throw new BadRequestException(
        'El archivo del certificado debe tener extensión .cer',
      );
    }
    if (keyFile.size > MAX_EFIRMA_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `El archivo .key excede el tamaño máximo permitido (${Math.floor(MAX_EFIRMA_FILE_SIZE_BYTES / 1024)}KB)`,
      );
    }
    if (cerFile.size > MAX_EFIRMA_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `El archivo .cer excede el tamaño máximo permitido (${Math.floor(MAX_EFIRMA_FILE_SIZE_BYTES / 1024)}KB)`,
      );
    }

    const documentBuffer = await this.minioService.getFileInBytesFormat(
      document.objectKey,
      BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
    );

    return (await this.efirmaService.firmar(
      documentBuffer,
      cerFile.buffer,
      keyFile.buffer,
      password,
    )) as SignatureResult;
  }

  /**
   * Copia la imagen de firma activa del usuario a un object key nuevo e inmutable en MinIO, y
   * retorna esa clave. Sólo se llama después de `assertCanSignWithSimpleSignature`, así que la
   * credencial ya está en CONFIGURED y la rúbrica existe. Ver docblock de
   * `CollaboratorEntity.signatureSnapshotObjectKey` para el porqué: sin este snapshot, el PDF
   * final quedaría vinculado a lo que sea que el usuario tenga en su perfil al momento en que
   * el ÚLTIMO firmante termine, no a lo que realmente firmó.
   */
  async snapshotSignatureImage(user: UserEntity): Promise<string> {
    const signature = await this.signatureService.findOne(
      user.signatureId as string,
    );
    const signatureBuffer = await this.minioService.getFileInBytesFormat(
      signature.signatureObjectKey,
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );
    const snapshot = await this.minioService.uploadObject(
      {
        file: signatureBuffer,
        name: 'signature-snapshot.png',
        mimetype: 'image/png',
      },
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );
    return snapshot.fileId;
  }

  /**
   * Encuentra la fila de Collaborator (SIGNER) del usuario autenticado en este documento, o
   * lanza ForbiddenException. Usado por el flujo de verificación (emitir/validar código) —
   * mismo criterio de acceso que sign()/reject().
   *
   * Bug corregido (encontrado probando el flujo completo de Firma Simple de punta a punta): el
   * Caso A de "Notificación por Email para Firma Simple y Vinculación de Cuenta" (usuario ya
   * autenticado, su Collaborator todavía sin accountId) solo estaba resuelto dentro de sign()/
   * reject(), no aquí. Pero Firma Simple SIEMPRE exige 2FA, y el código se solicita ANTES de
   * firmar — un firmante en Caso A nunca lograba pedir su código (se topaba con
   * ForbiddenException aquí primero), así que jamás llegaba a sign() para que la vinculación
   * perezosa de ahí lo rescatara. Se aplica el mismo criterio aquí.
   */
  async findMySignerCollaborator(
    documentId: string,
    currentUserId: string,
  ): Promise<CollaboratorEntity> {
    const relations = { account: { user: true } };
    const findMine = () =>
      this.collaboratorRepository.findOne({
        where: {
          documentId,
          account: { userId: currentUserId },
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
        relations,
      });

    let myParticipant = await findMine();

    if (!myParticipant) {
      const linkResult = await this.linkPendingCollaboratorAccount(
        documentId,
        currentUserId,
      );
      if (linkResult.data.linked) {
        myParticipant = await findMine();
      }
    }

    if (!myParticipant) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    return myParticipant;
  }

  /**
   * Manda a Seal Service los datos de los firmantes de un documento de FIRMA SIMPLE recién
   * completado (ver `SendCompletedSimpleSignatureToSealUseCase`, que decide si el documento
   * califica y arma el DTO).
   *
   * Se invoca cuando ya se guardó todo —el claim de la firma, el snapshot de la rúbrica del
   * último firmante y los hashes que escribió `finalizeSignedDocument`— y no desde dentro de esa
   * finalización: el caso de uso relee el documento de la base, así que correr antes le mostraría
   * un documento sin `signed_hash` y sin la rúbrica de quien acaba de firmar.
   *
   * Best-effort, con el mismo criterio que el sellado avanzado y los correos de finalización: a
   * esta altura la firma ya está registrada y el PDF ya está en su bucket. Devolver un 500 al
   * último firmante por un fallo del proveedor lo dejaría creyendo que su firma no ocurrió, y su
   * reintento chocaría contra el claim atómico ("ya respondiste") sin poder corregir nada.
   *
   * Del error se registra sólo su mensaje, nunca el DTO: lleva CURP, correo y la rúbrica del
   * firmante.
   */
  async sendSimpleSignaturesToSeal(documentId: string): Promise<void> {
    try {
      await this.sendCompletedSimpleSignatureToSeal.execute(documentId);
    } catch (error) {
      this.logger.error(
        `Error enviando las firmas simples del documento ${documentId} a Seal Service: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Envía a Seal Service el arreglo con las firmas avanzadas del documento y persiste la
   * evidencia que devuelve (historia "Completar flujo de firma avanzada e integración con Seal
   * Service"). Corre una sola vez por documento, cuando el último firmante terminó: el proveedor
   * calcula UN hash canónico sobre el conjunto completo de firmas, así que sellar antes —firma
   * por firma— produciría un hash de un conjunto parcial que ya no representa al documento final.
   *
   * Un documento sin ninguna firma avanzada (todo firma simple) no se sella: no hay firma
   * criptográfica de la cual construir la evidencia.
   *
   * Best-effort a propósito, igual que los correos de finalización: llegado este punto las firmas
   * ya están registradas y el PDF ya está en el bucket de firmados. Propagar un fallo del
   * proveedor devolvería un 500 al último firmante por algo que su firma sí logró, y su reintento
   * chocaría contra el claim atómico ("ya respondiste") sin poder corregir nada. El error queda
   * logueado, y el sellado puede reintentarse contra `POST /seal` con el mismo payload.
   */
  async sealAdvancedSignatures(
    document: DocumentEntity,
    signerCollaborators: CollaboratorEntity[],
  ): Promise<SealEntity | null> {
    const advancedSigners = signerCollaborators.filter(
      (collaborator) =>
        collaborator.signatureType === SIGNATURE_TYPE_ENUM.FIEL &&
        collaborator.advancedSignature !== null &&
        collaborator.advancedSignature !== undefined,
    );

    if (advancedSigners.length === 0) {
      return null;
    }

    /**
     * Sin la evidencia OCSP de TODOS los firmantes no se intenta sellar: Seal Service la exige y
     * respondería 400. El documento se marca como pendiente para poder retomarlo cuando el SAT
     * vuelva (ver `RetryPendingSealUseCase`) y para poder decírselo al usuario.
     *
     * Se comprueba antes de llamar en vez de dejar que el proveedor rechace, porque un 400
     * previsible no es un fallo del sellado: es una precondición que todavía no se cumple.
     */
    const sinEvidenciaOcsp = advancedSigners.some(
      (collaborator) => !collaborator.advancedSignature?.ocspEvidence,
    );

    if (sinEvidenciaOcsp) {
      this.logger.warn(
        `El documento ${document.id} queda pendiente de sellar: falta la evidencia OCSP de al menos un firmante.`,
      );
      await this.markSealingPending(document);
      return null;
    }

    // La traducción del payload va DENTRO del try junto con la llamada: si una firma guardada
    // tuviera una forma inesperada, el error debe tratarse como cualquier otro fallo de sellado
    // (logueado, sin efecto sobre la firma) y no escaparse como una excepción no controlada al
    // final de un flujo de firma que ya se completó.
    try {
      const sealDocumentDto: SealDocumentDto = {
        documentId: document.id,
        originalHash: document.originalHash,
        signatures: advancedSigners.map((collaborator) =>
          this.toSealSignature(collaborator.advancedSignature!),
        ),
      };

      const seal = await this.sealDocumentUseCase.create(sealDocumentDto);
      this.logger.log(
        `Sellos generados para el documento ${document.id} (evidencia ${seal.id}, ${advancedSigners.length} firma(s) avanzada(s)).`,
      );
      return seal;
    } catch (error) {
      this.logger.error(
        `Error sellando el documento ${document.id} con Seal Service: ${error}`,
      );

      // El documento ya estaba sellado: pasa cuando un intento anterior selló pero falló más
      // adelante y la firma se reintentó. La constancia existe, así que se relee en vez de
      // perderla y dejar la hoja sin ella.
      if (error instanceof DocumentAlreadySealedException) {
        return await this.sealDocumentUseCase
          .findByDocumentId(document.id)
          .catch(() => null);
      }

      return null;
    }
  }

  /**
   * Marca el documento como pendiente de sellar, conservando la marca original si ya la tenía:
   * lo que interesa es DESDE CUÁNDO espera, no cuándo se comprobó por última vez.
   *
   * Best-effort como el resto del sellado: si no se puede escribir la marca, el documento sigue
   * firmado y válido. Se registra y se sigue, en vez de tumbar un flujo de firma ya completado.
   */
  private async markSealingPending(document: DocumentEntity): Promise<void> {
    if (document.sealingPendingAt) {
      return;
    }

    try {
      document.sealingPendingAt = new Date();
      await this.documentRepository.update(document.id, {
        sealingPendingAt: document.sealingPendingAt,
      });
    } catch (error) {
      this.logger.error(
        `No se pudo marcar el documento ${document.id} como pendiente de sellar: ${error}`,
      );
    }
  }

  /**
   * Traduce el resultado de `EfirmaService.firmar` (persistido tal cual en
   * `CollaboratorEntity.advancedSignature`) al contrato que espera Seal Service.
   *
   * Toda fecha se normaliza a ISO 8601 pasando por `Date`, y no llamando a `.toISOString()`
   * directo, porque `advancedSignature` es una columna **jsonb**: el mismo campo llega como `Date`
   * cuando la firma se acaba de hacer en esta misma petición, y como **string** cuando se releyó
   * de la base. El proveedor ordena y canonicaliza las firmas por `signedAt`, así que las dos
   * rutas tienen que producir exactamente el mismo texto.
   *
   * Bug corregido: `ocspEvidence.verifiedAt` sí llamaba a `.toISOString()` directo. Como
   * `sealAdvancedSignatures` relee del repositorio a TODOS los firmantes del documento, las firmas
   * anteriores a la del último llegaban siempre desde jsonb —con `verifiedAt` como string— y
   * reventaban con "verifiedAt.toISOString is not a function". El `try/catch` de
   * `sealAdvancedSignatures` se tragaba el error (el sellado es best-effort), así que el síntoma no
   * era una excepción sino que **ningún documento FIEL de más de un firmante llegaba a sellarse**:
   * su hoja de evidencia salía con la tabla NOM-151 vacía y sin descargas.
   *
   * `ocspEvidence` se omite cuando la firma no la trae, en vez de reventar: las firmas guardadas
   * antes de que existiera la verificación OCSP no la tienen, y el proveedor no la usa para
   * construir el hash (ver `buildSignatureHash` en seal-service, que canonicaliza solo el
   * certificado, el algoritmo, la firma y la fecha). Sellar sin ella es correcto; no sellar, no.
   */
  toSealSignature(
    signature: SignatureResult,
  ): SealDocumentDto['signatures'][number] {
    const { ocspEvidence } = signature;

    return {
      signatureBase64: String(signature.signatureBase64),
      algorithm: signature.algorithm,
      signedAt: new Date(signature.signedAt).toISOString(),
      certificate: {
        rfc: signature.certificate.rfc,
        name: signature.certificate.name,
        issuer: signature.certificate.issuer,
        serialNumber: signature.certificate.serialNumber,
        certificateNumber: signature.certificate.certificateNumber,
        certificatePem: signature.certificate.certificatePem,
      },
      // El campo se omite entero cuando la firma no trae evidencia, en vez de mandar un objeto a
      // medio llenar: `ocspEvidence` es `@IsOptional()` en el DTO del proveedor, pero leer
      // `.status` sobre `undefined` revienta, y como el sellado es best-effort el `try/catch` se
      // traga la excepción y el documento se queda sin constancia sin ningún error visible.
      ...(ocspEvidence && {
        ocspEvidence: {
          status: ocspEvidence.status,
          // Mismo motivo que `signedAt`: recién firmada llega como `Date`, releída de la columna
          // jsonb llega como string. Llamar `.toISOString()` directo reventaba la segunda ruta —y
          // con ella el sellado completo— en cuanto un documento tenía más de un firmante FIEL: la
          // evidencia del que ya había firmado siempre viene de jsonb.
          verifiedAt: new Date(ocspEvidence.verifiedAt).toISOString(),
          ocspResponse: ocspEvidence.ocspResponse,
          ocspUrl: ocspEvidence.ocspUrl,
        },
      }),
    };
  }

  /**
   * Imagen que se estampa por un firmante, o `null` si no hay nada que dibujar.
   *
   * Los dos tipos de firma se distinguen SOLO acá; de este punto en adelante el estampado es
   * idéntico para ambos —misma caja, mismas coordenadas, mismo `mergeSignatureIntoPdf`—, que es
   * justamente lo que pide la historia "Generar código QR para firmas avanzadas": que el QR sea
   * el equivalente visual de la rúbrica de una firma simple.
   *
   *  - Firma simple: la rúbrica del firmante, tomada del snapshot inmutable del momento de firmar
   *    (ver `signatureSnapshotObjectKey`), no de su perfil en vivo.
   *  - Firma avanzada (e.firma): un código QR con los datos del firmante y del evento de firma
   *    (ver `SignatureQrService`). Su evidencia es criptográfica y no produce ninguna imagen, así
   *    que antes su espacio quedaba vacío.
   *
   * El QR se genera únicamente cuando la firma avanzada YA se completó: mientras el firmante siga
   * pendiente no hay firma que consultar, así que no se dibuja nada y su espacio sigue libre.
   */
  /**
   * Datos que se codifican en el QR de una firma avanzada (historia "Actualizar contenido del
   * código QR en firma avanzada").
   *
   * Todo describe a ESA firma y no al perfil del firmante hoy: el nombre y el RFC salen del
   * certificado del SAT con el que firmó —con los datos del colaborador como respaldo, mismo
   * criterio que `getAdvancedSignaturePublicView`— y la IP y la fecha son las que quedaron
   * registradas al firmar. La ubicación se sigue guardando, pero ya no se publica (ver
   * `SignatureQrService`). El documento se puede leer años después; el QR tiene que
   * seguir diciendo lo que pasó, no lo que pasa.
   */
  toAdvancedSignatureQrData(
    document: DocumentEntity,
    collaborator: CollaboratorEntity,
  ): AdvancedSignatureQrData {
    const certificate = collaborator.advancedSignature?.certificate;

    return {
      signerName: certificate?.name ?? collaboratorDisplayName(collaborator),
      rfc: certificate?.rfc ?? collaborator.rfc,
      ipAddress: collaborator.ipAddress,
      signedAt:
        collaborator.advancedSignature?.signedAt ?? collaborator.signedAt,
      verificationUrl: buildAdvancedSignatureUrl(document.id, collaborator.id),
    };
  }

  async resolveStampImage(
    document: DocumentEntity,
    collaborator: CollaboratorEntity,
  ): Promise<Buffer | null> {
    if (collaborator.signatureType === SIGNATURE_TYPE_ENUM.FIEL) {
      if (collaborator.status !== SIGNEE_STATUS_ENUM.SIGNED) {
        return null;
      }

      return this.signatureQrService.generateAdvancedSignaturePng(
        this.toAdvancedSignatureQrData(document, collaborator),
      );
    }

    // Los firmantes siempre tienen cuenta de plataforma (accountId no-nulo): solo watchers
    // y reviewers pueden invitarse por email únicamente (ver create()). Fallback defensivo
    // por si la relación account.user no vino cargada (no debería pasar: signerCollaborators
    // siempre se consulta con relations: { account: { user: true } }).
    const signerUser =
      collaborator.account?.user ??
      (await this.userService.findOne(
        (
          await this.collaboratorRepository.findOneOrFail({
            where: { id: collaborator.id },
            relations: { account: { user: true } },
          })
        ).account!.userId,
      ));

    // Usa el snapshot inmutable tomado en el momento real de la firma (ver
    // `signatureSnapshotObjectKey` / `snapshotSignatureImage`) — NO la firma en vivo del
    // perfil del usuario, que pudo haber sido desactivada/reemplazada después de firmar.
    // El fallback a la firma en vivo es solo defensivo, para filas ya firmadas antes de
    // este fix que todavía no tienen snapshot.
    const signatureObjectKey =
      collaborator.signatureSnapshotObjectKey ??
      (await this.signatureService.findOne(signerUser.signatureId))
        .signatureObjectKey;

    return this.minioService.getFileInBytesFormat(
      signatureObjectKey,
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );
  }

  /**
   * Estampa las firmas de todos los firmantes (apiladas), mueve el archivo a firmados y notifica
   * a todos los colaboradores.
   *
   * Lo que se estampa es ÚNICAMENTE la imagen de la firma (historia "Eliminar nombre al estampar
   * firma simple"): antes cada estampado agregaba también el nombre del firmante como texto
   * debajo de la imagen, lo que ensuciaba el documento y duplicaba un dato que ya vive en la hoja
   * de firmas del resumen (ver `SummaryDocumentService.buildSignerBlock`, que sigue imprimiendo
   * Nombre/RFC/IP/OTP/fecha por firmante) — la identidad del firmante no se pierde, solo deja de
   * dibujarse encima del contenido del PDF.
   */
  async finalizeSignedDocument(
    document: DocumentEntity,
    signerCollaborators: CollaboratorEntity[],
  ): Promise<void> {
    try {
      const documentBuffer = await this.stampSignaturesOnto(
        document,
        signerCollaborators,
      );

      const signerNames = signerCollaborators
        .map(collaboratorDisplayName)
        .join(', ');

      await this.minioService.uploadPdfAObject(
        {
          file: documentBuffer,
          name: document.fileName,
          mimetype: 'application/pdf',
        },
        BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
        signerNames,
        document.objectKey,
      );

      document.signedHash =
        await this.hashService.generateFileHash(documentBuffer);
      document.signedAt = new Date();

      // Sellado con Seal Service ANTES de armar la hoja: el documento ya tiene todas sus firmas
      // avanzadas (que es lo que el proveedor necesita para un único hash del conjunto) y la hoja
      // imprime la constancia resultante en su tabla NOM-151. Antes corría después de la hoja, así
      // que esa tabla salía siempre vacía. Sigue siendo best-effort: si el sellado falla, la firma
      // no se ve afectada y la hoja se arma sin constancia, como hasta ahora.
      const seal = await this.sealAdvancedSignatures(
        document,
        signerCollaborators,
      );

      // La versión definitiva se arma DESPUÉS de calcular signedHash y ANTES de marcar el
      // documento como SIGNED: la hoja imprime ese hash, y si el anexado falla el documento no
      // queda firmado (el flujo de `sign()` deshace la firma y permite reintentar), en vez de
      // dejar un documento firmado que el usuario no podría ver porque su versión final no existe.
      await this.attachSignaturesSheet(
        document,
        signerCollaborators,
        documentBuffer,
        signerNames,
        seal,
      );

      document.status = DOCUMENT_STATUS_ENUM.SIGNED;
      await this.documentRepository.save(document);
    } catch (error) {
      this.logger.error(`Error estampando documento: ${error}`);
      throw new Error(`Error estampando el documento: ${error}`);
    }

    try {
      await this.sendCompletionEmails(document.id);
    } catch (error) {
      this.logger.error(
        `Error enviando correos de finalización del documento ${document.id}: ${error}`,
      );
    }
  }

  /**
   * Dibuja sobre el PDF ORIGINAL las rúbricas de los colaboradores recibidos y devuelve el buffer
   * resultante. Siempre parte del original y nunca de una versión ya estampada: así el resultado
   * depende solo de quiénes se le pasen, y estampar dos veces no puede superponer una firma sobre
   * otra ni desplazarla.
   *
   * Qué se dibuja por cada colaborador lo decide `resolveStampImage` —rúbrica para firma simple,
   * código QR para firma avanzada ya completada—; acá solo se resuelve DÓNDE va.
   *
   * Lo usan los dos caminos que producen un PDF con firmas —el documento final
   * (`finalizeSignedDocument`) y la vista previa del avance (`refreshPartiallySignedPreview`)—
   * para que ambos coloquen cada rúbrica exactamente en el mismo lugar: la vista previa no es una
   * aproximación de cómo va a quedar el documento, es literalmente el mismo estampado con menos
   * firmantes.
   */
  async stampSignaturesOnto(
    document: DocumentEntity,
    signerCollaborators: CollaboratorEntity[],
  ): Promise<Buffer> {
    let documentBuffer = await this.minioService.getFileInBytesFormat(
      document.objectKey,
      BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
    );

    const baseCoordinates: SignatureCoordinates =
      document.signatureCoordinates ?? DEFAULT_COORDINATES;
    const verticalStep = baseCoordinates.height + SIGNATURE_STAMP_VERTICAL_GAP;

    // Coordenadas por colaborador (ver Fase 4 del plan de migración ER-V2): quien tiene
    // simpleSignature explícita se estampa ahí; el resto se apila automáticamente desde el
    // ancla del documento, exactamente como antes — el índice de apilado solo avanza para
    // los colaboradores SIN coordenadas explícitas, para que no colisionen entre sí.
    let autoStackIndex = 0;
    for (const collaborator of signerCollaborators) {
      const signatureBuffer = await this.resolveStampImage(
        document,
        collaborator,
      );

      // Nada que estampar por este firmante: firma avanzada todavía pendiente (su QR no existe
      // hasta que firma) o firma simple sin rúbrica resoluble.
      if (!signatureBuffer) {
        continue;
      }

      // La caja de firma es apaisada porque está pensada para una rúbrica; un QR estirado ahí
      // deja de ser cuadrado y los lectores no reconocen su patrón. Se encaja centrado, sin
      // deformarlo. Las rúbricas siguen ocupando la caja completa, exactamente como antes.
      const stampOptions = {
        preserveAspectRatio:
          collaborator.signatureType === SIGNATURE_TYPE_ENUM.FIEL,
      };

      if (collaborator.simpleSignature) {
        // Firmante creado por el flujo nuevo (ver historia "Ubicación de firmas por
        // usuario"): un arreglo vacío significa que no colocó ninguna posición — se firma
        // sin estampar nada visualmente, y el loop de abajo simplemente no itera. Con
        // elementos, se estampa UNA vez por cada posición (páginas/zonas distintas).
        for (const position of collaborator.simpleSignature
          .signatureCoordinates) {
          if (isRatioSignaturePosition(position)) {
            const { coordinates, pageIndex } =
              await this.documentSigningSerivice.resolveRatioPosition(
                documentBuffer,
                position,
              );
            documentBuffer =
              await this.documentSigningSerivice.mergeSignatureIntoPdf(
                documentBuffer,
                signatureBuffer,
                coordinates,
                pageIndex,
                stampOptions,
              );
          } else {
            // Dato legacy (pre-migración `ArraySignatureCoordinates`, en píxeles absolutos,
            // sin ratios) — se respeta el comportamiento de siempre: página por defecto
            // (última), sin intentar una conversión a ratios con pérdida de precisión.
            const legacyCoordinates: SignatureCoordinates = {
              x: position.x,
              y: position.y,
              width: position.width,
              height: position.height,
              opacity: position.opacity,
            };
            documentBuffer =
              await this.documentSigningSerivice.mergeSignatureIntoPdf(
                documentBuffer,
                signatureBuffer,
                legacyCoordinates,
                undefined,
                stampOptions,
              );
          }
        }
      } else {
        // Colaborador creado por el endpoint POST /document más antiguo (nunca asigna
        // simpleSignatureId) — apilado automático sin cambios respecto al comportamiento
        // previo a esta historia.
        const coordinates: SignatureCoordinates = {
          ...baseCoordinates,
          y: baseCoordinates.y + autoStackIndex * verticalStep,
        };
        autoStackIndex += 1;

        documentBuffer =
          await this.documentSigningSerivice.mergeSignatureIntoPdf(
            documentBuffer,
            signatureBuffer,
            coordinates,
            undefined,
            stampOptions,
          );
      }
    }

    return documentBuffer;
  }

  /**
   * Regenera la vista previa del documento con las firmas registradas hasta ahora (historia
   * "Actualizar el previsualizador con el avance de firmas"). Se llama después de cada firma que
   * NO cierra el documento: quien lo abra mientras faltan firmantes ve las rúbricas de los que ya
   * firmaron, en su posición definitiva, y los espacios de quienes faltan siguen vacíos.
   *
   * Se reconstruye entera desde el original en vez de agregarle una rúbrica a la vista previa
   * anterior: estampar de forma incremental acumularía el resultado de cada pasada, y un
   * reintento o una firma repetida terminaría dibujando dos veces sobre el mismo lugar.
   *
   * Nunca interrumpe la firma: es una copia de conveniencia, y quien acaba de firmar ya tiene su
   * firma registrada en la base pase lo que pase acá. Si falla, el visor sigue mostrando la vista
   * previa anterior (o el original) y la próxima firma vuelve a intentarlo.
   */
  async refreshPartiallySignedPreview(
    document: DocumentEntity,
    signerCollaborators: CollaboratorEntity[],
  ): Promise<void> {
    const signed = signerCollaborators.filter(
      (collaborator) => collaborator.status === SIGNEE_STATUS_ENUM.SIGNED,
    );
    if (signed.length === 0) {
      return;
    }

    try {
      const previewBuffer = await this.stampSignaturesOnto(document, signed);

      await this.minioService.uploadPdfAObject(
        {
          file: previewBuffer,
          name: document.fileName,
          mimetype: 'application/pdf',
        },
        BUCKET_TYPES_ENUM.PARTIALLY_SIGNED_DOCUMENTS,
        signed.map(collaboratorDisplayName).join(', '),
        document.objectKey,
      );
    } catch (error) {
      this.logger.error(
        `Error generando la vista previa con el avance de firmas del documento ${document.id}: ${error}`,
      );
    }
  }

  /**
   * Anexa la hoja de información de firmas al documento firmado y guarda ese resultado en el
   * bucket de documentos finalizados (historia "Anexar hoja existente de información de firmas al
   * documento final"). Esa copia es la versión definitiva: la única que el usuario ve y descarga.
   *
   * Cada tipo de firma tiene su propia hoja (historia "Crear hoja de evidencia específica para
   * firma avanzada"): `SummaryDocumentService` para la firma simple y
   * `AdvancedSummaryDocumentService` para la avanzada, que acredita cosas distintas —certificado
   * del SAT, número de serie y la firma electrónica de cada firmante, en vez de OTP y cifrado del
   * Audit Trail—. La elección es lo único que se decide acá; de ahí en adelante solo se concatenan
   * páginas, igual para ambas.
   *
   * Nada de lo que entra se modifica: el original sigue intacto en `created_documents` y el
   * documento firmado en `signed_documents` —que es el insumo con el que se calculó `signedHash`,
   * y por eso no puede llevar la hoja encima—. Esto solo escribe una tercera copia.
   */
  async attachSignaturesSheet(
    document: DocumentEntity,
    signerCollaborators: CollaboratorEntity[],
    signedDocument: Buffer,
    signerNames: string,
    seal: SealEntity | null = null,
  ): Promise<void> {
    const creator = await this.userService.findOne(document.createdBy);

    const sheetDocumentInfo = {
      id: document.id,
      documentName: document.fileName,
      hash: document.signedHash,
      totalPages: document.totalPages,
      createdBy: creator.email,
      verificationUrl: buildPublicDocumentUrl(document.id),
    };

    const summarySheet = isAdvancedSignatureDocument(signerCollaborators)
      ? await this.advancedSummaryDocumentService.generateAdvancedSummaryPdf(
          {
            ...sheetDocumentInfo,
            conservationRecord: toConservationRecord(seal),
          },
          signerCollaborators.map((collaborator) =>
            this.toAdvancedSummarySigner(collaborator),
          ),
        )
      : await this.summaryDocumentService.generateSummaryPdf(
          sheetDocumentInfo,
          signerCollaborators.map((collaborator) =>
            this.toSummarySigner(collaborator),
          ),
        );

    const finalizedDocument = await this.documentSigningSerivice.appendPdfPages(
      signedDocument,
      summarySheet,
    );

    await this.minioService.uploadPdfAObject(
      {
        file: finalizedDocument,
        name: document.fileName,
        mimetype: 'application/pdf',
      },
      BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
      signerNames,
      document.objectKey,
    );
  }

  /** Traduce un colaborador firmante a un renglón de la sección "Firmas" de la hoja. */
  toSummarySigner(collaborator: CollaboratorEntity): SummaryDocumentSigner {
    return {
      name: collaboratorDisplayName(collaborator),
      ipAddress: collaborator.ipAddress,
      signedAt: collaborator.signedAt,
    };
  }

  /**
   * Traduce un colaborador que firmó con e.firma a una tabla de la sección "Firmas" de la hoja de
   * evidencia avanzada.
   *
   * Todo lo específico de la firma avanzada sale de `advancedSignature` —el resultado no sensible
   * que `EfirmaService.firmar` dejó guardado al validar la e.firma—, nunca de algo que se vuelva a
   * resolver en vivo: la hoja tiene que describir la firma tal como ocurrió.
   *
   * El nombre preferido es el del certificado (el que el SAT tiene registrado para ese RFC, el más
   * fiel a quién firmó), con el del perfil como respaldo — mismo criterio que
   * `getAdvancedSignaturePublicView`.
   */
  toAdvancedSummarySigner(
    collaborator: CollaboratorEntity,
  ): AdvancedSummaryDocumentSigner {
    const advancedSignature = collaborator.advancedSignature;

    return {
      name:
        advancedSignature?.certificate?.name ??
        collaboratorDisplayName(collaborator),
      ipAddress: collaborator.ipAddress,
      certificateSerialNumber:
        advancedSignature?.certificate?.serialNumber ?? null,
      electronicSignature: advancedSignature
        ? String(advancedSignature.signatureBase64)
        : null,
      // `advancedSignature.signedAt` es el momento real del firmado criptográfico; `signedAt` del
      // colaborador es cuando se registró en la base y solo se usa como respaldo.
      signedAt: advancedSignature?.signedAt ?? collaborator.signedAt,
    };
  }

  /**
   * Envía el PDF final firmado por correo a todos los colaboradores (firmantes, watchers y
   * reviewers) y, por separado, a quien creó el documento — que no siempre es también un
   * colaborador, así que sin esto se quedaba sin ningún aviso de que ya se completó la firma.
   */
  async sendCompletionEmails(documentId: string): Promise<void> {
    const document = await this.findOne(documentId);
    const collaborators = await this.collaboratorRepository.find({
      where: { documentId },
      relations: { account: { user: true } },
    });
    const creator = await this.userService.findOne(document.createdBy);

    // Se adjunta la versión definitiva (documento + hoja de firmas), no la de `signed_documents`:
    // el correo de finalización es, para la mayoría de los colaboradores, la única copia que van a
    // conservar, así que tiene que ser exactamente la misma que verían en la plataforma.
    const signedBuffer = await this.minioService.getFileInBytesFormat(
      document.objectKey,
      BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
    );

    const signerNames = collaborators
      .filter((c) => c.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER)
      .map(collaboratorDisplayName);

    await Promise.all([
      ...collaborators.map((collaborator) =>
        this.emailService.sendDocumentSignedNotification(
          collaboratorEmail(collaborator),
          collaboratorDisplayName(collaborator),
          document.fileName,
          signedBuffer,
        ),
      ),
      this.emailService.sendDocumentCompletedToCreatorNotification(
        creator.email,
        `${creator.firstName} ${creator.lastName}`,
        document.fileName,
        signerNames,
        signedBuffer,
      ),
    ]);
  }
}

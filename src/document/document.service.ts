import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { FindOptionsRelations, ILike, IsNull, Repository } from 'typeorm';

import { DocumentEntity } from './entities/document.entity';
import { CollaboratorEntity } from './entities/collaborator.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';

import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';
import { COLABORATOR_TYPE_ENUM } from './enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from './enum/signee-status.enum';
import { SIGNATURE_TYPE_ENUM } from './enum/signature-type.enum';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { DEFAULT_COORDINATES } from 'src/shared/document-signing/interfaces/default-signing-coordinates.interface';
import { SignatureCoordinates } from 'src/shared/document-signing/interfaces/signature-coordinates.interface';
import type {
  LegacySignatureCoordinates,
  SignaturePositionRecord,
} from 'src/signature/entities/simple-signature.entity';

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

/** Distingue el shape nuevo de posición (ratios 0-1) del legacy (píxeles absolutos) dentro del mismo arreglo `signatureCoordinates`. */
function isRatioSignaturePosition(
  position: SignaturePositionRecord | LegacySignatureCoordinates,
): position is SignaturePositionRecord {
  return 'xRatio' in position;
}

/**
 * Reúne las capacidades que comparten los casos de uso de `applications/`: resolver documentos y
 * colaboradores, decidir acceso y bucket de cada archivo, firmar con e.firma, estampar y sellar el
 * PDF, y avisar por correo.
 *
 * Ningún flujo de endpoint vive acá: cada acción de negocio —crear, enviar a autorización, firmar,
 * rechazar, cancelar— es un caso de uso, y lo que queda son las piezas que más de uno reutiliza.
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
    // Firmado se sirve desde la versión definitiva (documento + hoja de firmas), no desde la copia
    // de `signed_documents`, que sólo alimenta el `signedHash` (ver `attachSignaturesSheet`).
    // CANCELLATION_PENDING es posterior a la firma y muestra esa misma versión.
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
   * Deriva el tipo de firma (`simple` / `fiel`) desde los SIGNER, o `null` si no se puede
   * determinar. No vive en `DocumentEntity`: el flujo de creación copia el mismo valor a todos sus
   * firmantes, y éstos ya vienen en el query del listado, así que no agrega consultas.
   *
   * Exige que todos coincidan en vez de tomar el primero: los documentos del endpoint viejo
   * (`POST /document`) nunca asignaron tipo, y un `null` explícito es información honesta donde el
   * tipo del primer firmante sería una suposición.
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
   * Resuelve el colaborador del usuario autenticado para operaciones de LECTURA: primero por cuenta
   * vinculada, si no por email (case-insensitive) contra invitaciones que aún no tienen `accountId`.
   *
   * Empareja por email porque ese campo sigue en null hasta que el firmante entra por el enlace del
   * correo, mientras que el listado sí filtra por email: sin esto el detalle respondía 403 sobre
   * documentos que el usuario veía en "Por firmar". No amplía el modelo de seguridad —`sign()` y
   * `reject()` identifican al firmante igual, y el email está verificado por OTP en el registro.
   *
   * No vincula nada: una lectura no puede tener el efecto secundario de asociar la cuenta.
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
   * Vincula al usuario autenticado como Collaborator de un documento al que fue invitado sólo por
   * email. Empareja por email (case-insensitive) porque, mientras no hay `accountId`, es la única
   * señal disponible para identificarlo.
   *
   * No lanza si no hay nada que vincular (`linked: false`): no tener una invitación pendiente con
   * ese email es el caso normal de cualquier documento ajeno a este flujo.
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
   * Resuelve `myParticipant` y el arreglo de firmantes, vinculando por email al usuario autenticado
   * que todavía no figura como colaborador —llegó con sesión activa desde el enlace del correo.
   *
   * Lo comparten firmar y rechazar: cuando sólo `sign()` lo hacía, rechazar como primera acción
   * fallaba con ForbiddenException aunque el email sí coincidiera con una invitación pendiente.
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
   * Resuelve el bucket del que se sirve un documento: `STATUS_BUCKET_MAP` más la única excepción que
   * el estatus no alcanza a expresar —un PENDING donde ya firmó alguien se sirve de la vista previa
   * con esas firmas estampadas, no del original.
   *
   * Toda ruta de lectura pasa por acá para que no discrepen sobre qué versión corresponde.
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

  /**
   * Genera la URL segura del archivo en Minio según el estatus del documento.
   *
   * `asAttachment` distingue descargar de previsualizar. Al descargar nombra el archivo con
   * `file_name` —el nombre que el usuario reconoce— en vez de con la clave del objeto, que es un
   * UUID; al previsualizar no manda cabecera, porque `attachment` haría que el visor descargue el
   * PDF en lugar de mostrarlo.
   *
   * El nombre lo resuelve el backend y viaja firmado dentro de la URL, para que ninguna pantalla
   * pueda bautizar el archivo por su cuenta.
   */
  async getDocumentMinioURL(
    documentId: string,
    { asAttachment = false }: { asAttachment?: boolean } = {},
  ) {
    try {
      const document = await this.findOne(documentId);
      const bucket = this.resolveDocumentBucket(document);
      // Conserva la llamada de dos argumentos en la rama de previsualización: `getFile` recibe el
      // nombre de descarga en su cuarto parámetro, y pasarlo como `undefined` volvería vacuas las
      // pruebas `not.toHaveBeenCalledWith` que verifican que un documento firmado nunca se sirve
      // desde el bucket equivocado.
      const fileResponse = asAttachment
        ? await this.minioService.getFile(
            document.objectKey,
            bucket,
            undefined,
            document.fileName,
          )
        : await this.minioService.getFile(document.objectKey, bucket);

      return fileResponse;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new Error(`Error obteniendo URL del Documento: ${error}`);
    }
  }

  /**
   * Expone un firmante de documento TODAVÍA PENDIENTE: sólo su nombre. Los demás campos van en
   * `null` y no se omiten, para que el frontend renderice una sola forma en ambos estados.
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
   * Expone un firmante de documento COMPLETADO con la evidencia que corresponde a su tipo de firma.
   *
   * Reproduce campo por campo la que imprime la hoja anexada al PDF (`toSummarySigner` /
   * `toAdvancedSummarySigner`): esta pantalla es la versión consultable de esa hoja, no una segunda
   * fuente de verdad.
   *
   * Devuelve `null` —nunca cadena vacía— en los campos del otro tipo, para que el frontend oculte
   * el renglón entero en vez de pintarlo sin valor.
   *
   * Omite la geolocalización: esta ruta la abre cualquiera con el id y sin sesión. Se sigue
   * guardando en `collaborator.geoLoc` como evidencia.
   */
  async toCompletedPublicSigner(
    documentId: string,
    collaborator: CollaboratorEntity,
  ): Promise<PublicSignerData> {
    const advancedSignature = collaborator.advancedSignature;

    if (collaborator.signatureType === SIGNATURE_TYPE_ENUM.FIEL) {
      return {
        id: collaborator.id,
        // Prefiere el nombre del certificado, el que el SAT tiene registrado para ese RFC —mismo
        // criterio que `getAdvancedSignaturePublicView` y la hoja de evidencia avanzada.
        name:
          advancedSignature?.certificate?.name ??
          collaboratorDisplayName(collaborator),
        signatureType: SIGNATURE_TYPE_ENUM.FIEL,
        signatureTypeLabel: ADVANCED_SIGNATURE_TYPE_LABEL,
        legalBacking: ADVANCED_SIGNATURE_BACKING_LABEL,
        ipAddress: collaborator.ipAddress,
        // `advancedSignature.signedAt` es el momento real del firmado criptográfico; el del
        // colaborador sólo registra cuándo se escribió en la base y sirve de respaldo.
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
      // Acredita con qué código se validó su identidad. Puede no existir: la verificación por OTP
      // depende de `document.requiresVerification`, y sin ella el renglón no se muestra.
      otpCode: await this.verificationCodeService.findConsumedCode(
        documentId,
        collaborator.id,
        VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
      ),
      certificateSerialNumber: null,
      electronicSignature: null,
    };
  }

  /** Lanza NotFoundException si el documento no existe. */
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
   * Autoriza la descarga del archivo: exige ser creador o colaborador, con el mismo criterio que
   * `resolveMyCollaborator` —por cuenta vinculada o, si la invitación sigue pendiente, por email.
   *
   * Sin el emparejamiento por email la pantalla de detalle cargaba pero el archivo no (el visor
   * recibía 403 en `/document/file/:id`), dejando la firma a medias.
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
   * Exige `signingCredentialStatus` en CONFIGURED para poder firmar con firma Simple.
   *
   * La credencial es la única variable que responde esta pregunta: comprobar a mano que existan la
   * rúbrica y la identificación dejaba pasar a un usuario con el PNG cargado pero con la
   * verificación de identidad rechazada.
   *
   * No aplica a la firma avanzada: ahí la identidad la acredita el certificado del SAT, y su
   * equivalente es `validateAndSignWithEfirma`.
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
   * Valida el `.key`/`.cer`/contraseña del firmante FIEL y ejecuta la firma criptográfica sobre el
   * documento actual.
   *
   * Delega toda la validación real (contraseña, vigencia del certificado, cadena de confianza SAT,
   * correspondencia llave/certificado) a `EfirmaService.firmar`, que no se expone como endpoint y
   * sólo se invoca acá. Sus errores (422, en español) se propagan tal cual, sin envolverlos.
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
   * Congela la imagen de firma activa del usuario en un object key nuevo e inmutable y devuelve esa
   * clave. Sin el snapshot, el PDF final quedaría vinculado a lo que el usuario tenga en su perfil
   * cuando termine el ÚLTIMO firmante, no a lo que realmente firmó (ver
   * `CollaboratorEntity.signatureSnapshotObjectKey`).
   *
   * Corre siempre después de `assertCanSignWithSimpleSignature`, así que la rúbrica ya existe.
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
   * Resuelve la fila de Collaborator (SIGNER) del usuario autenticado, o lanza ForbiddenException.
   * La usa el flujo de verificación (emitir/validar código) con el mismo criterio de acceso que
   * `sign()`/`reject()`, vinculación por email incluida.
   *
   * Firma Simple siempre exige 2FA y el código se pide ANTES de firmar: mientras ese criterio vivió
   * sólo dentro de `sign()`, un firmante todavía sin `accountId` fallaba acá y nunca alcanzaba la
   * vinculación perezosa que lo habría rescatado.
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
   * Manda a Seal Service los firmantes de un documento de FIRMA SIMPLE recién completado
   * (`SendCompletedSimpleSignatureToSealUseCase` decide si califica y arma el DTO).
   *
   * Corre dentro de `finalizeSignedDocument`, después de persistir `signed_hash` y antes de armar
   * la hoja de evidencia: es lo único que permite que su tabla NOM-151 salga llena.
   *
   * El caso de uso relee TODO de la base, así que cualquier dato que la evidencia necesite tiene que
   * estar escrito antes de llegar acá. Son dos: `signed_hash` y el snapshot de la rúbrica de cada
   * firmante, que `SignDocumentUseCase` persiste apenas lo toma —y no en su `save` final, posterior
   * a este punto— precisamente por esto.
   *
   * Best-effort, con el mismo criterio que el sellado avanzado y los correos de finalización: a esta
   * altura la firma ya está registrada y el PDF en su bucket, y un 500 dejaría al último firmante
   * creyendo que su firma no ocurrió, con el reintento bloqueado por el claim atómico.
   *
   * Del error registra sólo el mensaje, nunca el DTO: lleva CURP, correo y la rúbrica del firmante.
   */
  async sealSimpleSignatures(documentId: string): Promise<SealEntity | null> {
    try {
      return await this.sendCompletedSimpleSignatureToSeal.execute(documentId);
    } catch (error) {
      this.logger.error(
        `Error enviando las firmas simples del documento ${documentId} a Seal Service: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Envía a Seal Service las firmas avanzadas del documento y persiste la evidencia que devuelve.
   *
   * Corre una sola vez por documento, cuando terminó el último firmante: el proveedor calcula UN
   * hash canónico sobre el conjunto completo de firmas, así que sellar firma por firma produciría el
   * hash de un conjunto parcial que ya no representa al documento final.
   *
   * Un documento sin ninguna firma avanzada no se sella: no hay firma criptográfica de la cual
   * construir la evidencia.
   *
   * Best-effort: llegado este punto las firmas ya están registradas y el PDF está en el bucket de
   * firmados, así que propagar un fallo del proveedor devolvería un 500 por algo que sí funcionó y el
   * reintento chocaría contra el claim atómico. El error queda logueado y el sellado puede repetirse
   * contra `POST /seal` con el mismo payload.
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
     * Exige evidencia OCSP de TODOS los firmantes antes de intentar el sellado: Seal Service la pide
     * y respondería 400. Marca el documento como pendiente para retomarlo cuando el SAT vuelva (ver
     * `RetryPendingSealUseCase`) y poder informárselo al usuario.
     *
     * Comprueba antes de llamar porque un 400 previsible no es un fallo del sellado, sino una
     * precondición que todavía no se cumple.
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

    // Traduce el payload DENTRO del try: si una firma guardada tuviera una forma inesperada, el
    // error debe tratarse como cualquier otro fallo de sellado —logueado, sin efecto sobre la
    // firma— y no escaparse al final de un flujo de firma ya completado.
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

      // Relee la constancia en vez de perderla: el documento ya estaba sellado porque un intento
      // anterior selló pero falló más adelante y la firma se reintentó.
      if (error instanceof DocumentAlreadySealedException) {
        return await this.sealDocumentUseCase
          .findByDocumentId(document.id)
          .catch(() => null);
      }

      return null;
    }
  }

  /**
   * Marca el documento como pendiente de sellar conservando la marca original: lo que interesa es
   * DESDE CUÁNDO espera, no cuándo se comprobó por última vez.
   *
   * Best-effort como el resto del sellado: si la marca no se puede escribir, el documento sigue
   * firmado y válido.
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
   * Convierte el resultado de `EfirmaService.firmar` —persistido tal cual en
   * `CollaboratorEntity.advancedSignature`— al contrato que espera Seal Service.
   *
   * Normaliza toda fecha a ISO 8601 pasando por `Date`, y no con `.toISOString()` directo, porque
   * `advancedSignature` es una columna **jsonb**: el mismo campo llega como `Date` recién firmado y
   * como string cuando se releyó de la base. El proveedor ordena y canonicaliza las firmas por
   * `signedAt`, así que ambas rutas tienen que producir exactamente el mismo texto.
   *
   * Cuando `verifiedAt` usaba `.toISOString()` directo, ningún documento FIEL de más de un firmante
   * llegaba a sellarse: las firmas anteriores a la última siempre vienen de jsonb, y el `try/catch`
   * best-effort se tragaba el error —la hoja salía con la tabla NOM-151 vacía, sin excepción visible.
   *
   * Omite `ocspEvidence` cuando la firma no la trae: las firmas guardadas antes de que existiera la
   * verificación OCSP no la tienen, y el proveedor no la usa para construir el hash (ver
   * `buildSignatureHash` en seal-service). Sellar sin ella es correcto; no sellar, no.
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
      // Omite el campo entero cuando la firma no trae evidencia, en vez de mandar un objeto a medio
      // llenar: `ocspEvidence` es `@IsOptional()` en el DTO del proveedor, pero leer `.status` sobre
      // `undefined` revienta y el `try/catch` best-effort deja al documento sin constancia y sin
      // ningún error visible.
      ...(ocspEvidence && {
        ocspEvidence: {
          status: ocspEvidence.status,
          // Mismo motivo que `signedAt`: releída de la columna jsonb llega como string, y
          // `.toISOString()` directo tumbaba el sellado completo en cuanto el documento tenía más de
          // un firmante FIEL.
          verifiedAt: new Date(ocspEvidence.verifiedAt).toISOString(),
          ocspResponse: ocspEvidence.ocspResponse,
          ocspUrl: ocspEvidence.ocspUrl,
        },
      }),
    };
  }

  /**
   * Codifica en el QR de una firma avanzada únicamente el enlace a la vista pública, que es la que
   * decide qué publica de cada firmante —antes el nombre, el RFC, la IP y la fecha se imprimían como
   * texto dentro del código. La URL señala a ESTE colaborador, así que dos firmas avanzadas del
   * mismo documento nunca codifican el mismo QR.
   */
  toAdvancedSignatureQrData(
    document: DocumentEntity,
    collaborator: CollaboratorEntity,
  ): AdvancedSignatureQrData {
    return {
      verificationUrl: buildAdvancedSignatureUrl(document.id, collaborator.id),
    };
  }

  /**
   * Resuelve la imagen que se estampa por un firmante, o `null` si no hay nada que dibujar: la
   * rúbrica del snapshot inmutable del momento de firmar en firma simple, y un QR a la verificación
   * pública en firma avanzada (`SignatureQrService`), cuya evidencia es criptográfica y no produce
   * ninguna imagen.
   *
   * Es el único punto donde los dos tipos se distinguen: de acá en adelante el estampado es idéntico
   * para ambos —misma caja, mismas coordenadas, mismo `mergeSignatureIntoPdf`.
   *
   * Sólo genera el QR con la firma avanzada ya completada: mientras el firmante siga pendiente no hay
   * firma que consultar y su espacio queda libre.
   */
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

    // Los firmantes siempre tienen cuenta de plataforma: sólo watchers y reviewers pueden invitarse
    // por email únicamente (ver `create()`). El fallback es defensivo, por si la relación
    // `account.user` no vino cargada.
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

    // Usa el snapshot inmutable del momento de la firma, no la rúbrica en vivo del perfil, que pudo
    // desactivarse o reemplazarse después de firmar. El fallback cubre las filas firmadas antes de
    // que el snapshot existiera.
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
   * Estampa las firmas de todos los firmantes, mueve el archivo a firmados y notifica a los
   * colaboradores.
   *
   * Estampa ÚNICAMENTE la imagen de la firma: el nombre del firmante ensuciaba el documento y ya
   * vive en la hoja de firmas (`SummaryDocumentService.buildSignerBlock` imprime nombre, RFC, IP,
   * OTP y fecha), así que la identidad no se pierde, sólo deja de dibujarse sobre el contenido.
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

      /**
       * Persiste `signed_hash` ANTES de sellar: el sellado de firma simple relee el documento de la
       * base para armar su evidencia y, sin este guardado, leería la fila sin hash y se descartaría
       * a sí mismo. El estado pasa a SIGNED al final, después de la hoja, para que un fallo al
       * armarla deje el documento reintentable.
       */
      await this.documentRepository.update(document.id, {
        signedHash: document.signedHash,
        signedAt: document.signedAt,
      });

      /**
       * Sella ANTES de armar la hoja, para los dos tipos de firma: la hoja imprime la constancia
       * resultante en su tabla NOM-151, y sellar después la dejaba siempre vacía.
       *
       * Best-effort en ambos casos: si el sellado falla, la firma no se ve afectada y la hoja se
       * arma sin constancia.
       */
      const seal =
        (await this.sealAdvancedSignatures(document, signerCollaborators)) ??
        (await this.sealSimpleSignatures(document.id));

      // Arma la versión definitiva DESPUÉS de calcular `signedHash` —la hoja lo imprime— y ANTES de
      // marcar SIGNED: si el anexado falla, `sign()` deshace la firma y permite reintentar, en vez
      // de dejar un documento firmado cuya versión final no existe.
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
   * resultante.
   *
   * Parte siempre del original y nunca de una versión ya estampada: así el resultado depende sólo de
   * quiénes se le pasen, y estampar dos veces no puede superponer una firma sobre otra ni
   * desplazarla.
   *
   * Resuelve sólo DÓNDE va cada rúbrica; QUÉ se dibuja lo decide `resolveStampImage`.
   *
   * Lo comparten el documento final (`finalizeSignedDocument`) y la vista previa del avance
   * (`refreshPartiallySignedPreview`) para que ambos coloquen cada rúbrica en el mismo lugar: la
   * vista previa es literalmente el mismo estampado con menos firmantes, no una aproximación.
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

    // Estampa a quien tenga `simpleSignature` en sus coordenadas explícitas y apila al resto desde
    // el ancla del documento. El índice de apilado sólo avanza para los colaboradores SIN
    // coordenadas, para que no colisionen entre sí.
    let autoStackIndex = 0;
    for (const collaborator of signerCollaborators) {
      const signatureBuffer = await this.resolveStampImage(
        document,
        collaborator,
      );

      // Omite al firmante sin nada que estampar: firma avanzada todavía pendiente (su QR no existe
      // hasta que firma) o firma simple sin rúbrica resoluble.
      if (!signatureBuffer) {
        continue;
      }

      // Encaja el QR centrado sin deformarlo: la caja de firma es apaisada porque está pensada para
      // una rúbrica, y un QR estirado pierde su patrón cuadrado y los lectores dejan de
      // reconocerlo. Las rúbricas siguen ocupando la caja completa.
      const stampOptions = {
        preserveAspectRatio:
          collaborator.signatureType === SIGNATURE_TYPE_ENUM.FIEL,
      };

      if (collaborator.simpleSignature) {
        // Estampa una vez por cada posición colocada (páginas o zonas distintas). Un arreglo vacío
        // significa que el firmante no colocó ninguna: firma sin estampar nada visualmente.
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
                {
                  ...stampOptions,
                  /**
                   * Conserva el tamaño ya decidido: sale de la caja que el usuario dibujó sobre la
                   * página y se calculó contra las dimensiones reales de esa hoja. El resize
                   * automático existe para tamaños sin respaldo (ver `mergeSignatureIntoPdf`), y acá
                   * sustituiría la caja configurada por el tamaño por defecto —la firma saldría con
                   * otro tamaño y desplazada, sin ningún error de por medio.
                   */
                  normalizeSize: false,
                },
              );
          } else {
            // Respeta el comportamiento legacy (píxeles absolutos, sin ratios): página por defecto,
            // sin intentar una conversión a ratios con pérdida de precisión.
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
        // Colaborador del endpoint `POST /document` más antiguo, que nunca asigna
        // `simpleSignatureId`: apilado automático.
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
   * Regenera la vista previa con las firmas registradas hasta ahora, después de cada firma que NO
   * cierra el documento: quien lo abra mientras faltan firmantes ve las rúbricas ya hechas en su
   * posición definitiva, y los espacios pendientes siguen vacíos.
   *
   * Reconstruye entera desde el original en vez de agregar una rúbrica a la vista previa anterior:
   * estampar de forma incremental acumularía el resultado de cada pasada, y un reintento dibujaría
   * dos veces sobre el mismo lugar.
   *
   * Nunca interrumpe la firma: es una copia de conveniencia, y la firma ya está registrada pase lo
   * que pase acá. Si falla, el visor sigue mostrando la vista previa anterior.
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
   * Anexa la hoja de información de firmas al documento firmado y guarda el resultado en el bucket
   * de finalizados. Esa copia es la versión definitiva: la única que el usuario ve y descarga.
   *
   * Elige la hoja según el tipo de firma —`SummaryDocumentService` para la simple,
   * `AdvancedSummaryDocumentService` para la avanzada, que acredita certificado del SAT, número de
   * serie y firma electrónica en vez de OTP y cifrado del Audit Trail—. Es lo único que se decide
   * acá; de ahí en adelante sólo se concatenan páginas.
   *
   * No modifica nada de lo que entra: el original sigue intacto en `created_documents` y el firmado
   * en `signed_documents` —el insumo con el que se calculó `signedHash`, y por eso no puede llevar
   * la hoja encima—. Esto sólo escribe una tercera copia.
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
      // La constancia va en las DOS hojas: ambos tipos de firma se sellan ante el PSC y ambas
      // plantillas llevan su tabla NOM-151.
      conservationRecord: toConservationRecord(seal),
    };

    const summarySheet = isAdvancedSignatureDocument(signerCollaborators)
      ? await this.advancedSummaryDocumentService.generateAdvancedSummaryPdf(
          sheetDocumentInfo,
          signerCollaborators.map((collaborator) =>
            this.toAdvancedSummarySigner(collaborator),
          ),
        )
      : await this.summaryDocumentService.generateSummaryPdf(
          sheetDocumentInfo,
          // Cada firmante requiere una consulta para recuperar su OTP consumido, que en una firma
          // simple es su prueba de identidad.
          await Promise.all(
            signerCollaborators.map((collaborator) =>
              this.toSummarySigner(document.id, collaborator),
            ),
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

  /**
   * Traduce a una tabla de la sección "Firmas" al colaborador que firmó con firma simple.
   *
   * Resuelve el OTP acá en vez de heredarlo del colaborador: en una firma simple ese código ES la
   * prueba de identidad —no hay certificado que la acredite—, y mientras este método no lo llenaba
   * el renglón "OTP CODE" salía vacío en todas las hojas.
   *
   * Puede no existir: la verificación por OTP depende de `document.requiresVerification`, y en ese
   * caso el renglón queda vacío, que es correcto.
   */
  async toSummarySigner(
    documentId: string,
    collaborator: CollaboratorEntity,
  ): Promise<SummaryDocumentSigner> {
    return {
      name: collaboratorDisplayName(collaborator),
      ipAddress: collaborator.ipAddress,
      signedAt: collaborator.signedAt,
      otpCode: await this.verificationCodeService.findConsumedCode(
        documentId,
        collaborator.id,
        VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
      ),
    };
  }

  /**
   * Traduce a una tabla de la sección "Firmas" de la hoja de evidencia avanzada al colaborador que
   * firmó con e.firma.
   *
   * Toma todo lo específico de la firma avanzada de `advancedSignature` —el resultado no sensible
   * que `EfirmaService.firmar` dejó guardado— y nunca de algo resuelto en vivo: la hoja tiene que
   * describir la firma tal como ocurrió.
   *
   * Prefiere el nombre del certificado, el que el SAT tiene registrado para ese RFC, con el del
   * perfil como respaldo —mismo criterio que `getAdvancedSignaturePublicView`.
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
      // `advancedSignature.signedAt` es el momento real del firmado criptográfico; el del colaborador
      // sólo registra cuándo se escribió en la base y sirve de respaldo.
      signedAt: advancedSignature?.signedAt ?? collaborator.signedAt,
    };
  }

  /**
   * Envía el PDF final firmado por correo a todos los colaboradores y, por separado, a quien creó el
   * documento: el creador no siempre es también colaborador, y sin esto se quedaba sin ningún aviso
   * de que la firma se completó.
   */
  async sendCompletionEmails(documentId: string): Promise<void> {
    const document = await this.findOne(documentId);
    const collaborators = await this.collaboratorRepository.find({
      where: { documentId },
      relations: { account: { user: true } },
    });
    const creator = await this.userService.findOne(document.createdBy);

    // Adjunta la versión definitiva (documento + hoja de firmas), no la de `signed_documents`: para
    // la mayoría de los colaboradores este correo es la única copia que van a conservar, y tiene que
    // ser la misma que verían en la plataforma.
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

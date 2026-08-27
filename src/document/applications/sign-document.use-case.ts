import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditService } from 'src/audit/audit.service';
import { AuditAction } from 'src/audit/schema/audit-document';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import type { SignatureResult } from 'src/efirma/interfaces/signature-result.interface';
import { UserEntity } from 'src/user/entities/user.entity';

import { GeolocationDto } from '../dto/sign-document.dto';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { SIGNEE_STATUS_ENUM } from '../enum/signee-status.enum';
import { VERIFICATION_EVENT_ENUM } from '../enum/verification-event.enum';
import { isSignerTurn } from '../utils/next-signer.util';
import { VerificationCodeService } from '../verification-code.service';
import { AdvancedSignatureInput, DocumentService } from '../document.service';

/**
 * `PATCH /document/:id/sign`: registra la firma del usuario autenticado.
 *
 * Es la acción central del producto y su orden importa: se valida la e.firma antes de reclamar
 * el turno, se reclama el turno con un UPDATE condicionado antes de tocar MinIO, y se estampa
 * el PDF antes de dar la firma por buena. Cada uno de esos límites existe para que un fallo a
 * media operación no deje al firmante marcado como que ya firmó sin una firma detrás.
 *
 * Si soy el último firmante pendiente, acá mismo se finaliza el documento: se estampa, se sella
 * y se avisa a todos.
 */
@Injectable()
export class SignDocumentUseCase {
  private readonly logger = new Logger(SignDocumentUseCase.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly auditService: AuditService,
    private readonly documentEventsProducer: DocumentEventsProducer,
    private readonly verificationCodeService: VerificationCodeService,
    private readonly documentService: DocumentService,
  ) {}

  async execute(
    documentId: string,
    currentUserId: string,
    advancedSignatureInput?: AdvancedSignatureInput,
    geolocation?: GeolocationDto,
  ): Promise<BaseResponse<{ id: string }>> {
    // La ubicación es obligatoria para firmar. El DTO ya la exige (400 desde ValidationPipe),
    // pero se revalida aquí porque `sign()` también se invoca desde otros puntos internos y una
    // firma sin esta evidencia no debe poder registrarse por ninguna vía.
    if (!geolocation) {
      throw new BadRequestException(
        'La geolocalización es obligatoria para poder firmar el documento',
      );
    }

    const document = await this.documentService.findOne(documentId);

    if (document.status !== DOCUMENT_STATUS_ENUM.PENDING) {
      throw new BadRequestException(
        `El documento no puede firmarse. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.PENDING}', el estatus actual es '${document.status}'`,
      );
    }

    const { signerCollaborators, myParticipant } =
      await this.documentService.findOrLinkMySignerCollaborator(
        documentId,
        currentUserId,
        {
          account: { user: true },
          simpleSignature: true,
        },
      );

    if (!myParticipant) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    if (myParticipant.status !== SIGNEE_STATUS_ENUM.PENDING) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }

    if (
      !isSignerTurn(myParticipant, signerCollaborators, document.isSequential)
    ) {
      throw new ForbiddenException(
        'Aún no es tu turno para firmar este documento',
      );
    }

    // La validación de e.firma (contraseña, vigencia del certificado, cadena de confianza,
    // correspondencia llave/certificado — todo vía EfirmaService) corre ANTES del claim atómico
    // a propósito: si falla (contraseña incorrecta es el caso más común, se espera que el
    // firmante reintente), no debe dejar al colaborador marcado como SIGNED sin una firma válida
    // detrás. Para firma simple, el equivalente es `assertCanSignWithSimpleSignature`.
    let advancedSignatureResult: SignatureResult | null = null;
    if (myParticipant.signatureType === SIGNATURE_TYPE_ENUM.FIEL) {
      advancedSignatureResult =
        await this.documentService.validateAndSignWithEfirma(
          document,
          advancedSignatureInput,
        );
    } else {
      this.documentService.assertCanSignWithSimpleSignature(
        myParticipant.account!.user,
      );
    }

    // Gateo por código de verificación (ver plan de migración ER-V2, Fase 7): opt-in por
    // documento vía requiresVerification (default false) — si está apagado, el flujo de firma
    // sigue exactamente igual que siempre, sin ningún riesgo para el caso dominante.
    if (document.requiresVerification) {
      const hasVerified = await this.verificationCodeService.hasConsumedCode(
        documentId,
        myParticipant.id,
        VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
      );
      if (!hasVerified) {
        throw new BadRequestException(
          'Este documento requiere verificación. Solicita y valida tu código antes de firmar.',
        );
      }
    }

    // Claim atómico (bug corregido): un UPDATE condicionado a status=PENDING es lo único que
    // realmente cierra la ventana de carrera entre dos peticiones casi simultáneas para el
    // mismo firmante (doble clic, dos pestañas, reintento por timeout) — la validación en
    // memoria de arriba (`myParticipant.status !== PENDING`) no alcanza porque ambas peticiones
    // pueden pasarla antes de que cualquiera escriba. Si `affected !== 1`, alguien más ya ganó
    // la carrera; se aborta aquí, antes de tocar MinIO/estampado/correos, así que no hay
    // estampado duplicado, correos duplicados a todos los colaboradores, ni auditoría duplicada.
    const claim = await this.collaboratorRepository.update(
      { id: myParticipant.id, status: SIGNEE_STATUS_ENUM.PENDING },
      { status: SIGNEE_STATUS_ENUM.SIGNED, signedAt: new Date() },
    );
    if (claim.affected !== 1) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }
    myParticipant.status = SIGNEE_STATUS_ENUM.SIGNED;
    myParticipant.signedAt = new Date();
    // Evidencia declarada por el dispositivo del firmante (navigator.geolocation), no verificada
    // independientemente por el servidor. Siempre presente: firmar sin ubicación se rechaza al
    // inicio de este método y en el DTO.
    myParticipant.geoLoc = geolocation;

    if (myParticipant.signatureType === SIGNATURE_TYPE_ENUM.FIEL) {
      // Resultado ya validado arriba (antes del claim) — solo se persiste. No contiene la llave
      // privada ni la contraseña, ver docblock de `CollaboratorEntity.advancedSignature`.
      myParticipant.advancedSignature = advancedSignatureResult;
    } else {
      // Snapshot inmutable tomado AHORA, en el momento real de la firma — ver docblock de
      // `signatureSnapshotObjectKey` y la migración asociada. Sin esto, finalizeSignedDocument()
      // (que corre después, cuando firma el ÚLTIMO firmante) volvería a leer la firma EN VIVO de
      // cada colaborador, y un firmante que desactivó su firma entre que firmó y que el último
      // terminó quedaría con un PNG en blanco estampado en el PDF legal final, sin ningún error.
      // Se toma después del claim a propósito: si el claim se pierde, no se desperdicia esta
      // llamada a MinIO.
      myParticipant.signatureSnapshotObjectKey =
        await this.documentService.snapshotSignatureImage(
          myParticipant.account!.user as UserEntity,
        );
    }

    const remainingSigners = signerCollaborators.filter(
      (c) =>
        c.id !== myParticipant.id && c.status === SIGNEE_STATUS_ENUM.PENDING,
    );

    // Si soy el último firmante pendiente, estampo y finalizo el documento ANTES de
    // registrar mi firma: si el estampado falla, ni el colaborador ni el documento
    // quedan marcados como firmados, y la firma puede reintentarse sin quedar atascada.
    document.completedSignersCount = (document.completedSignersCount ?? 0) + 1;

    if (remainingSigners.length === 0) {
      // finalizeSignedDocument guarda `document` (ya con completedSignersCount incrementado) y
      // sella con Seal Service antes de armar la hoja de evidencia, para que la constancia
      // NOM-151 alcance a imprimirse en ella.
      await this.documentService.finalizeSignedDocument(
        document,
        signerCollaborators,
      );
      this.documentEventsProducer.emitSigned({
        documentId,
        fileName: document.fileName,
        actorUserId: currentUserId,
      });
    } else {
      await this.documentRepository.update(documentId, {
        completedSignersCount: document.completedSignersCount,
      });
      // Todavía faltan firmantes: se refresca la vista previa para que quien abra el documento
      // vea ya estampada esta firma (historia "Actualizar el previsualizador con el avance de
      // firmas"). `myParticipant` ya está marcado como SIGNED en memoria, así que entra en el
      // estampado; los que faltan quedan con su espacio vacío. No se hace cuando firma el último
      // porque ahí el documento pasa a SIGNED y lo que se sirve es la versión definitiva.
      await this.documentService.refreshPartiallySignedPreview(
        document,
        signerCollaborators,
      );
    }

    // El claim atómico ya persistió status/signedAt — este save solo persiste
    // signatureSnapshotObjectKey (y re-escribe status/signedAt con el mismo valor, sin efecto).
    await this.collaboratorRepository.save(myParticipant);

    // Bug corregido: este evento alimenta el encadenamiento de DocumentTransaction y del ledger
    // global de auditoría (ver Kafka -> DocumentEventsConsumer) — se dispara AQUÍ, después de
    // que el snapshot de la firma ya quedó tomado y persistido, no justo tras el claim atómico.
    // Si se disparara antes y `snapshotSignatureImage` (llamada a MinIO) fallara, el evento ya
    // publicado dejaría un registro de "firmado" en ambas cadenas para una firma cuyo
    // signatureSnapshotObjectKey nunca se llegó a guardar — y el firmante, al reintentar, se
    // encontraría bloqueado por el claim atómico ("ya respondiste") sin poder corregirlo. Se
    // dispara por CADA firmante (no solo el último, a diferencia de emitSigned más abajo).
    this.documentEventsProducer.emitCollaboratorSigned({
      documentId,
      fileName: document.fileName,
      actorUserId: currentUserId,
      collaboratorId: myParticipant.id,
      signedAt: myParticipant.signedAt.toISOString(),
    });

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_SIGNED,
      ipAddress: document.ipAddress ?? '0.0.0.0',
      users: [{ userId: currentUserId, action: AuditAction.DOCUMENT_SIGNED }],
      signedAt: myParticipant.signedAt,
      geolocation,
    });

    if (remainingSigners.length > 0) {
      try {
        await this.documentService.notifyNextSigner(documentId);
      } catch (error) {
        this.logger.error(
          `Error notificando al siguiente firmante del documento ${documentId}: ${error}`,
        );
      }
      return {
        success: true,
        message:
          'Firma registrada correctamente. Se notificó al siguiente firmante.',
        data: { id: documentId },
      };
    }

    // Último firmante: el documento ya está completo y persistido (firma, snapshot de la rúbrica
    // y hashes), que es justo lo que el envío de firma simple necesita releer.
    await this.documentService.sendSimpleSignaturesToSeal(documentId);

    return {
      success: true,
      message: 'Documento firmado exitosamente por todos los firmantes',
      data: { id: documentId },
    };
  }
}

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
 * Lo que el firmante necesita saber en cuanto su firma queda registrada.
 *
 * @remarks
 * `documentCompleted` responde lo único que el llamador no puede contestar solo. Antes esa
 * diferencia viajaba sólo en el `message`, y ramificar desde el cliente obligaba a comparar
 * cadenas en español que existen para mostrarse: cambiarles una coma rompía la pantalla en
 * silencio.
 */
export interface SignedDocumentData {
  id: string;
  /**
   * `true` si esta firma fue la última que faltaba y el documento quedó completo; `false` si
   * quedan firmantes pendientes. Es el estado DESPUÉS de esta firma, no el que tenía al entrar.
   */
  documentCompleted: boolean;
}

/**
 * Registra la firma del usuario autenticado sobre un documento pendiente.
 *
 * @remarks
 * Flujo:
 *
 * 1. Exige la geolocalización: una firma sin esa evidencia no debe registrarse por ninguna vía.
 * 2. Comprueba que el documento esté en `PENDING`.
 * 3. Resuelve —o vincula— al colaborador firmante y valida permisos: que sea firmante, que no
 *    haya respondido ya, y que sea su turno si el documento es secuencial.
 * 4. Valida la credencial de firma: e.firma completa en firma avanzada, firma registrada en
 *    simple.
 * 5. Exige el código de verificación si el documento lo pide.
 * 6. Reclama el turno con un `UPDATE` condicionado a `PENDING` — el punto sin retorno.
 * 7. Guarda la evidencia de la firma: geolocalización, y el resultado de e.firma o el snapshot
 *    inmutable de la imagen de firma.
 * 8. Si era el último firmante pendiente, finaliza el documento (estampa, sella y notifica) y
 *    publica el evento; si no, avisa al siguiente en turno.
 *
 * **El orden de los pasos 4, 6 y 8 es la garantía central.** Validar la credencial ANTES de
 * reclamar el turno evita dejar al colaborador marcado como firmado sin una firma válida detrás
 * —una contraseña incorrecta es el fallo más común y se espera que el firmante reintente—, y
 * finalizar antes de dar la firma por buena permite reintentar si el estampado falla.
 *
 * **Doble firma.** La comprobación en memoria del paso 3 no cierra la carrera entre dos
 * peticiones casi simultáneas del mismo firmante (doble clic, dos pestañas, reintento por
 * timeout): las dos pueden pasarla antes de que cualquiera escriba. Lo que la cierra es el
 * `UPDATE` condicionado del paso 6, y va antes de tocar MinIO para que la petición perdedora no
 * deje estampado, correos ni auditoría duplicados.
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

  /**
   * Ejecuta el caso de uso.
   *
   * @param documentId Documento que se firma.
   * @param currentUserId Usuario autenticado que firma.
   * @param advancedSignatureInput Certificado, llave y contraseña de la e.firma. Sólo se usa —y
   *   sólo hace falta— cuando el firmante tiene `signatureType` FIEL.
   * @param geolocation Ubicación declarada por el dispositivo del firmante, obligatoria como
   *   evidencia de la firma.
   * @returns El documento firmado y si esta firma lo dejó completo.
   * @throws {BadRequestException} Cuando falta la geolocalización, el documento no está en
   *   `PENDING`, el firmante ya respondió, el documento exige un código de verificación que no se
   *   validó, o otra petición reclamó el turno primero.
   * @throws {ForbiddenException} Cuando el usuario no es firmante del documento o todavía no es
   *   su turno.
   */
  async execute(
    documentId: string,
    currentUserId: string,
    advancedSignatureInput?: AdvancedSignatureInput,
    geolocation?: GeolocationDto,
  ): Promise<BaseResponse<SignedDocumentData>> {
    // Se revalida aunque el DTO ya la exija: este método también se invoca desde otros puntos.
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

    // Opt-in por documento: apagado, el flujo de firma sigue igual que siempre.
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

    // `affected !== 1` significa que otra petición ya reclamó el turno.
    const claim = await this.collaboratorRepository.update(
      { id: myParticipant.id, status: SIGNEE_STATUS_ENUM.PENDING },
      { status: SIGNEE_STATUS_ENUM.SIGNED, signedAt: new Date() },
    );
    if (claim.affected !== 1) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }
    myParticipant.status = SIGNEE_STATUS_ENUM.SIGNED;
    myParticipant.signedAt = new Date();
    // Evidencia declarada por el dispositivo, no verificada por el servidor.
    myParticipant.geoLoc = geolocation;

    if (myParticipant.signatureType === SIGNATURE_TYPE_ENUM.FIEL) {
      // Ya validado antes del claim; nunca contiene la llave privada ni la contraseña.
      myParticipant.advancedSignature = advancedSignatureResult;
    } else {
      /**
       * Copia inmutable de la imagen de firma, tomada en el momento real de la firma.
       *
       * Sin ella, `finalizeSignedDocument` —que corre cuando firma el ÚLTIMO— releería la firma
       * EN VIVO de cada colaborador, y quien la hubiera desactivado entre medias quedaría con un
       * PNG en blanco estampado en el PDF legal, sin ningún error. Va después del claim para no
       * gastar la llamada a MinIO si el turno se pierde.
       */
      myParticipant.signatureSnapshotObjectKey =
        await this.documentService.snapshotSignatureImage(
          myParticipant.account!.user as UserEntity,
        );

      /**
       * Se escribe ya, y no en el `save` del final: el sellado corre dentro de
       * `finalizeSignedDocument` y RELEE los firmantes de la base para armar la evidencia del
       * PSC. Sin esta escritura, el snapshot del último firmante llegaba en NULL y la evidencia
       * se sellaba con su firma en vivo mientras el PDF se estampaba con el snapshot — las dos
       * rúbricas que el snapshot existe para garantizar que sean la misma.
       *
       * Un UPDATE puntual y no adelantar el `save` completo, que persiste además cosas ajenas.
       */
      await this.collaboratorRepository.update(myParticipant.id, {
        signatureSnapshotObjectKey: myParticipant.signatureSnapshotObjectKey,
      });
    }

    const remainingSigners = signerCollaborators.filter(
      (c) =>
        c.id !== myParticipant.id && c.status === SIGNEE_STATUS_ENUM.PENDING,
    );

    document.completedSignersCount = (document.completedSignersCount ?? 0) + 1;

    if (remainingSigners.length === 0) {
      // Sella antes de armar la hoja de evidencia, para que la constancia NOM-151 quepa en ella.
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

    // Lo que este save persiste, a esta altura, es la geolocalización y —en firma avanzada— la
    // firma electrónica. El claim atómico ya escribió status/signedAt y el snapshot de la rúbrica
    // se escribió apenas se tomó (ver arriba, lo necesita el sellado); re-escribirlos con el mismo
    // valor no tiene efecto.
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
        data: { id: documentId, documentCompleted: false },
      };
    }

    return {
      success: true,
      message: 'Documento firmado exitosamente por todos los firmantes',
      data: { id: documentId, documentCompleted: true },
    };
  }
}

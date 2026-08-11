import { Controller, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventPattern, Payload } from '@nestjs/microservices';
import {
  DOCUMENT_KAFKA_TOPICS,
  DocumentEventPayload,
  DocumentCollaboratorSignedPayload,
} from './document-events.topics';
import { NotificationEntity } from 'src/document/entities/notification.entity';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { SIGNEE_STATUS_ENUM } from 'src/document/enum/signee-status.enum';
import { ACTOR_TYPE_ENUM } from 'src/document/enum/actor-type.enum';
import { NOTIFICATION_CHANNEL_ENUM } from 'src/document/enum/notification-channel.enum';
import { getNextPendingSigner } from 'src/document/utils/next-signer.util';
import { DocumentTransactionService } from 'src/document/document-transaction.service';
import { AuditChainService } from 'src/audit-chain/audit-chain.service';
import { AUDIT_TYPE_ENUM } from 'src/audit-chain/enums/audit-type.enum';
import { SealClientService } from 'src/seal/seal-client.service';

/**
 * Consumidor real de los eventos de negocio del ciclo de vida del documento (ver
 * DocumentEventsProducer). Desde la Fase 6 del plan de migración ER-V2, además de loguear
 * cada evento, persiste un registro de Notification por cada colaborador que ya recibió (o
 * debió recibir) un correo en document.service.ts para ese mismo evento.
 *
 * Decisión (ver plan): el envío de correo real sigue siendo inline y síncrono en
 * document.service.ts (EmailService, inmediato) — este consumer NO reenvía correos, solo dejó
 * constancia de que el evento ocurrió y a quién le tocaba ser notificado. Escribir el registro
 * aquí (en vez de en document.service.ts) es async/eventual respecto a la transición de
 * estado, una diferencia de comportamiento intencional para no acoplar el flujo de firma a la
 * persistencia de auditoría de notificaciones.
 *
 * También encadena cada evento en el ledger global de auditoría (ver AuditChainService, "Módulo
 * de Auditoría e Integridad Global de BD") — deliberadamente en este mismo consumer y no en uno
 * nuevo: NestJS solo permite UN handler por patrón de Kafka dentro de un mismo microservicio
 * (@nestjs/microservices registra los handlers en un Map por patrón — un segundo `@Controller`
 * con el mismo `@EventPattern` simplemente pisaría a este, no correrían ambos), así que un
 * consumer de auditoría separado sobre estos mismos tópicos habría roto silenciosamente la
 * persistencia de notificaciones de arriba.
 */
@Controller()
export class DocumentEventsConsumer {
  private readonly logger = new Logger(DocumentEventsConsumer.name);

  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notificationRepository: Repository<NotificationEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly documentTransactionService: DocumentTransactionService,
    private readonly auditChainService: AuditChainService,
    private readonly sealClientService: SealClientService,
  ) {}

  @EventPattern(DOCUMENT_KAFKA_TOPICS.CREATED)
  async handleCreated(@Payload() payload: DocumentEventPayload) {
    // Sin correo enviado en la creación (ver document.service.ts create()) — nada que persistir.
    this.logEvent('creado', payload);
    await this.recordAudit(payload, AUDIT_TYPE_ENUM.CREATED);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.SENT_TO_SIGN)
  async handleSentToSign(@Payload() payload: DocumentEventPayload) {
    this.logEvent('enviado a firma', payload);
    await this.safely(async () => {
      const signers = await this.collaboratorRepository.find({
        where: {
          documentId: payload.documentId,
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
      });
      const nextSigner = getNextPendingSigner(signers);
      if (nextSigner) {
        await this.persistNotifications(payload.documentId, [nextSigner]);
      }
    }, payload);
    await this.recordAudit(payload, AUDIT_TYPE_ENUM.PENDING);
  }

  /**
   * Se dispara por CADA colaborador que firma (a diferencia de handleSigned, que solo procesa
   * cuando el documento queda completamente firmado) y es el único punto donde se decide qué
   * entra a la cadena de DocumentTransaction, según el tipo de firma:
   *
   * - **Firma simple** → un registro encadenado por cada firma.
   * - **Firma avanzada (FIEL)** → ningún registro por firmante; su evidencia criptográfica ya
   *   vive en `CollaboratorEntity.advancedSignature` (ver EfirmaService).
   * - Cuando esta firma es la que completa el documento y hay al menos una firma avanzada, se
   *   agrega el registro final del documento.
   *
   * El registro final se resuelve aquí y no en handleSigned a propósito: son tópicos distintos
   * (`document.signed` se emite además ANTES que este evento en sign()), así que Kafka no
   * garantiza en qué orden se consumen y la cadena podía cerrarse antes de encadenar la última
   * firma simple. Aquí ambas cosas ocurren en secuencia dentro del mismo handler.
   */
  @EventPattern(DOCUMENT_KAFKA_TOPICS.COLLABORATOR_SIGNED)
  async handleCollaboratorSigned(
    @Payload() payload: DocumentCollaboratorSignedPayload,
  ) {
    this.logEvent(
      `firmado por el colaborador ${payload.collaboratorId}`,
      payload,
    );

    try {
      const signers = await this.collaboratorRepository.find({
        where: {
          documentId: payload.documentId,
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
      });
      const signer = signers.find((s) => s.id === payload.collaboratorId);

      if (signer?.signatureType === SIGNATURE_TYPE_ENUM.SIMPLE) {
        await this.documentTransactionService.registerSignature(
          payload.documentId,
          payload.collaboratorId,
          payload.signedAt,
        );
      }

      await this.registerCompletionIfDone(payload.documentId, signers);
    } catch (error) {
      this.logger.error(
        `Error encadenando Document Transaction para el documento ${payload.documentId} (colaborador ${payload.collaboratorId}): ${error}`,
      );
    }

    await this.recordAudit(payload, AUDIT_TYPE_ENUM.SIGNATURES_PARTIAL, {
      collaboratorId: payload.collaboratorId,
    });
  }

  /**
   * Cierra la cadena del documento cuando ya no queda ningún firmante pendiente y el documento
   * incluye firma avanzada. En un documento de pura firma simple no se agrega nada: la última
   * firma ya dejó su propio registro y un registro final sería redundante.
   *
   * Es también el punto donde se solicita el sello al Seal Service, por la misma condición: el
   * servicio espera el arreglo con TODAS las firmas avanzadas del documento, así que solo tiene
   * sentido llamarlo una vez, cuando ya están todas.
   */
  private async registerCompletionIfDone(
    documentId: string,
    signers: CollaboratorEntity[],
  ): Promise<void> {
    const allSigned =
      signers.length > 0 &&
      signers.every((s) => s.status === SIGNEE_STATUS_ENUM.SIGNED);
    const hasAdvancedSignature = signers.some(
      (s) => s.signatureType === SIGNATURE_TYPE_ENUM.FIEL,
    );
    if (!allSigned || !hasAdvancedSignature) return;

    const document = await this.documentRepository.findOne({
      where: { id: documentId },
    });
    // El hash del PDF final ya estampado (finalizeSignedDocument corre antes de emitir el
    // evento): liga el último eslabón de la cadena al archivo que quedó como resultado.
    await this.documentTransactionService.registerCompletion(
      documentId,
      document?.signedHash ?? '',
    );

    // En su propio try/catch: el sellado depende de un servicio externo (Seal Service → PSC), y
    // que no esté disponible no debe deshacer ni bloquear el cierre de la cadena, que es local y
    // ya quedó escrito. El sello es idempotente y puede reintentarse después.
    try {
      await this.sealClientService.sealDocumentSignatures(
        documentId,
        document?.originalHash ?? '',
      );
    } catch (error) {
      this.logger.error(
        `Error solicitando el sello al Seal Service para el documento ${documentId}: ${error}`,
      );
    }
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.SIGNED)
  async handleSigned(@Payload() payload: DocumentEventPayload) {
    // emitSigned solo se dispara cuando el documento queda completamente firmado (ver sign()
    // en document.service.ts) — corresponde exactamente a sendCompletionEmails a TODOS.
    this.logEvent('firmado', payload);
    await this.safely(async () => {
      const collaborators = await this.collaboratorRepository.find({
        where: { documentId: payload.documentId },
      });
      await this.persistNotifications(payload.documentId, collaborators);
    }, payload);
    await this.recordAudit(payload, AUDIT_TYPE_ENUM.SIGNATURES_COMPLETED);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.REJECTED)
  async handleRejected(@Payload() payload: DocumentEventPayload) {
    // sendDocumentRejectedNotification solo notifica al creador, que no siempre tiene una fila
    // de Collaborator — se persiste sin collaboratorId (ver NotificationEntity).
    this.logEvent('rechazado', payload);
    await this.safely(
      () => this.persistCreatorNotification(payload.documentId),
      payload,
    );
    await this.recordAudit(payload, AUDIT_TYPE_ENUM.REJECTED);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.CANCELLATION_REQUESTED)
  async handleCancellationRequested(@Payload() payload: DocumentEventPayload) {
    this.logEvent('cancelación solicitada', payload);
    await this.safely(async () => {
      const signers = await this.collaboratorRepository.find({
        where: {
          documentId: payload.documentId,
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
      });
      await this.persistNotifications(payload.documentId, signers);
    }, payload);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.CANCELLED)
  async handleCancelled(@Payload() payload: DocumentEventPayload) {
    this.logEvent('cancelado', payload);
    await this.safely(async () => {
      const collaborators = await this.collaboratorRepository.find({
        where: { documentId: payload.documentId },
      });
      await this.persistNotifications(payload.documentId, collaborators);
    }, payload);
  }

  /** Un registro de Notification por colaborador, con actorType derivado de si tiene cuenta o fue invitado solo por email. */
  private async persistNotifications(
    documentId: string,
    collaborators: CollaboratorEntity[],
  ): Promise<void> {
    if (collaborators.length === 0) return;

    const rows = collaborators.map((collaborator) =>
      this.notificationRepository.create({
        collaboratorId: collaborator.id,
        documentId,
        isNotified: true,
        actorType: collaborator.accountId
          ? ACTOR_TYPE_ENUM.ACCOUNT
          : ACTOR_TYPE_ENUM.WATCHER,
        notificationChannelSource: NOTIFICATION_CHANNEL_ENUM.EMAIL,
        delivered: true,
        sentAt: new Date(),
      }),
    );

    await this.notificationRepository.save(rows);
  }

  private async persistCreatorNotification(documentId: string): Promise<void> {
    await this.notificationRepository.save(
      this.notificationRepository.create({
        collaboratorId: null,
        documentId,
        isNotified: true,
        actorType: ACTOR_TYPE_ENUM.ACCOUNT,
        notificationChannelSource: NOTIFICATION_CHANNEL_ENUM.EMAIL,
        delivered: true,
        sentAt: new Date(),
      }),
    );
  }

  /**
   * Encadena el evento en el ledger global de auditoría (ver AuditChainService). Best-effort,
   * mismo criterio que `safely()`: un fallo aquí no debe tumbar el consumer ni impedir que el
   * resto del procesamiento del evento (notificaciones, Document Transaction) continúe — solo
   * deja un hueco en el ledger para este evento puntual, la cadena sigue siendo válida a partir
   * del último registro exitoso.
   */
  private async recordAudit(
    payload: DocumentEventPayload,
    auditType: AUDIT_TYPE_ENUM,
    extraMetadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditChainService.recordEvent({
        documentId: payload.documentId,
        auditType,
        metadata: {
          fileName: payload.fileName,
          actorUserId: payload.actorUserId,
          ...extraMetadata,
        },
        timestamp: new Date(payload.timestamp),
      });
    } catch (error) {
      this.logger.error(
        `Error encadenando el ledger global de auditoría para el documento ${payload.documentId} (auditType=${auditType}): ${error}`,
      );
    }
  }

  /** Los errores al persistir Notification nunca deben tumbar el consumer — mismo criterio best-effort que EmailService en document.service.ts. */
  private async safely(
    fn: () => Promise<void>,
    payload: DocumentEventPayload,
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.error(
        `Error persistiendo notificaciones para el documento ${payload.documentId}: ${error}`,
      );
    }
  }

  private logEvent(action: string, payload: DocumentEventPayload) {
    this.logger.log(
      `Documento ${action}: ${payload.documentId} ("${payload.fileName}") por ${payload.actorUserId} @ ${payload.timestamp}`,
    );
  }
}

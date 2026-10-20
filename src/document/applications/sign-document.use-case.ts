import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { AuditService } from 'src/audit/audit.service';
import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { AuditAction } from 'src/audit/schema/audit-document';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import type { SignatureResult } from 'src/efirma/interfaces/signature-result.interface';
import { UserEntity } from 'src/user/entities/user.entity';
import { BiometricSignatureAttemptEntity } from 'src/biometric-signature/entities/biometric-signature-attempt.entity';
import { BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM } from 'src/biometric-signature/enums/biometric-signature-attempt-status.enum';

import { GeolocationDto } from '../dto/sign-document.dto';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { VERIFICATION_EVENT_ENUM } from '../enum/verification-event.enum';
import { isSignerTurn } from '../utils/next-signer.util';
import { VerificationCodeService } from '../verification-code.service';
import { AdvancedSignatureInput, DocumentService } from '../document.service';
import { DocumentAuthorizationPolicy } from '../policies/document-authorization.policy';
import { SIGNING_AUTHORIZATION_ENUM } from '../enum/signing-authorization.enum';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from '../enum/guest-signing-access-purpose.enum';
import {
  GuestSigningAccessService,
  hashInvitationEmail,
  revokeOpenGuestSigningAccesses,
} from '../services/guest-signing-access.service';
import {
  GuestAdvancedInvitationNotFoundException,
  InvalidGuestSigningAccessException,
} from '../exceptions/guest-signing-access.exceptions';

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

/** Firma FIEL de un invitado sin cuenta, tal como llega por la ruta pública. */
export interface GuestAdvancedSignatureRequest {
  /** Acceso temporal que acreditó el token (`jti`). */
  accessId: string;
  documentId: string;
  collaboratorId: string;
  /**
   * Hash del PDF que el invitado revisó (lo publica la vista del documento). Si ya no es el del
   * documento, la firma se rechaza: firmaría algo distinto de lo que leyó.
   */
  documentHash: string;
  advancedSignatureInput: AdvancedSignatureInput;
  geolocation?: GeolocationDto;
  /** IP de la petición de firma, evidencia del acto. */
  ipAddress: string | null;
}

/** Quién firma y con qué evidencia, una vez validado todo lo previo al claim. */
interface SignatureCompletion {
  document: DocumentEntity;
  participant: CollaboratorEntity;
  signerCollaborators: CollaboratorEntity[];
  /**
   * Actor de los eventos y de la auditoría: el `userId` del firmante, o
   * `guest-collaborator:{collaboratorId}` para un invitado sin cuenta. Ninguno de los dos destinos
   * lo usa como llave foránea.
   */
  actor: string;
  geolocation: GeolocationDto;
  advancedSignatureResult: SignatureResult | null;
  /** IP desde la que se autorizó la firma, cuando se conoce (biométrica e invitado FIEL). */
  ipAddress: string | null;
  /** Cómo se acreditó el firmante; queda en `collaborators.signing_authorization`. */
  signingAuthorization: SIGNING_AUTHORIZATION_ENUM;
  /**
   * Acceso de invitado con el que se firma. Si viene, el claim corre en una transacción que además
   * lo consume y exige que el colaborador siga sin cuenta: o quedan las tres cosas o ninguna.
   */
  guestAccessId?: string;
}

/**
 * Registra la firma de un colaborador sobre un documento pendiente.
 *
 * @remarks
 * Tres entradas, un mismo final:
 * - `execute`: la firma que entra por `PATCH /document/:id/sign` (simple y FIEL), del usuario
 *   autenticado. Nunca firma a un colaborador BIOMETRIC.
 * - `executeBiometric`: la firma biométrica, desde el webhook de Didit. Resuelve al firmante por el
 *   colaborador del intento aprobado, así que sirve también a invitados sin cuenta.
 * - `executeGuestAdvanced`: la Firma Avanzada (FIEL) de un invitado sin cuenta, con el acceso
 *   temporal que obtuvo al validar el código de su correo.
 *
 * Flujo:
 *
 * 1. Exige la geolocalización: una firma sin esa evidencia no debe registrarse por ninguna vía.
 * 2. Comprueba que el documento esté en `PENDING`.
 * 3. Resuelve al colaborador firmante y valida que no haya respondido ya y que sea su turno si el
 *    documento es secuencial.
 * 4. Valida la credencial de firma: e.firma completa en firma avanzada, firma registrada en
 *    simple, e intento aprobado por Didit —sobre el mismo PDF— en biométrica.
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
 * timeout, webhook duplicado): las dos pueden pasarla antes de que cualquiera escriba. Lo que la
 * cierra es el `UPDATE` condicionado del paso 6, y va antes de tocar MinIO para que la petición
 * perdedora no deje estampado, correos ni auditoría duplicados.
 */
@Injectable()
export class SignDocumentUseCase {
  private readonly logger = new Logger(SignDocumentUseCase.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    @InjectRepository(BiometricSignatureAttemptEntity)
    private readonly biometricAttemptRepository: Repository<BiometricSignatureAttemptEntity>,
    private readonly auditService: AuditService,
    private readonly documentEventsProducer: DocumentEventsProducer,
    private readonly verificationCodeService: VerificationCodeService,
    private readonly documentService: DocumentService,
    private readonly authorizationPolicy: DocumentAuthorizationPolicy,
    private readonly guestSigningAccessService: GuestSigningAccessService,
  ) {}

  /**
   * Registra la firma simple o FIEL del usuario autenticado (`PATCH /document/:id/sign`).
   *
   * @param documentId Documento que se firma.
   * @param currentUserId Usuario autenticado que firma.
   * @param advancedSignatureInput Certificado, llave y contraseña de la e.firma. Sólo se usa —y
   *   sólo hace falta— cuando el firmante tiene `signatureType` FIEL.
   * @param geolocation Ubicación declarada por el dispositivo del firmante, obligatoria como
   *   evidencia de la firma.
   * @param authorization Contexto que dejó `PermissionsGuard` cuando la firma entra por
   *   `PATCH /document/:id/sign`. Es OPCIONAL, y no por comodidad: este caso de uso también se
   *   invoca desde flujos que no vienen de esa ruta y que por lo tanto no tienen contexto de
   *   autorización. Cuando llega, `DocumentAuthorizationPolicy` comprueba además el alcance
   *   `SELF` del catálogo; cuando no, siguen rigiendo las validaciones de firmante y de turno
   *   que este método ya hacía, que son las que de verdad protegen la firma.
   * @returns El documento firmado y si esta firma lo dejó completo.
   * @throws {BadRequestException} Cuando falta la geolocalización, el documento no está en
   *   `PENDING`, el firmante ya respondió, el documento exige un código de verificación que no se
   *   validó, otra petición reclamó el turno primero, o el firmante es BIOMETRIC (su firma sólo se
   *   registra con la aprobación de Didit, ver `executeBiometric`).
   * @throws {ForbiddenException} Cuando el usuario no es firmante del documento, todavía no es
   *   su turno, o su rol no tiene concedido `DOCUMENT.SIGN_SELF`.
   *
   * @example
   * ```ts
   * await signDocument.execute('d-1', 'u-1', undefined, { latitude: 19.4, longitude: -99.1 }, auth);
   * ```
   */
  async execute(
    documentId: string,
    currentUserId: string,
    advancedSignatureInput?: AdvancedSignatureInput,
    geolocation?: GeolocationDto,
    authorization?: AuthorizationContext,
  ): Promise<BaseResponse<SignedDocumentData>> {
    // Se revalida aunque el DTO ya la exija: este método también se invoca desde otros puntos.
    if (!geolocation) {
      throw new BadRequestException(
        'La geolocalización es obligatoria para poder firmar el documento',
      );
    }

    const document = await this.documentService.findOne(documentId);
    this.assertPendingSignature(document);

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

    /**
     * Va aquí y no antes porque `SIGN + SELF` se valida CONTRA el participante: el guard ya
     * comprobó que el rol puede firmar, y lo que falta es que quien firma sea el firmante, algo
     * que sólo se sabe una vez resuelto (o enlazado) el colaborador.
     */
    if (authorization) {
      this.authorizationPolicy.assertCanSign({
        document,
        authorization,
        participant: myParticipant,
      });
    }

    this.assertCanRespond(document, myParticipant, signerCollaborators);

    /**
     * Un firmante BIOMETRIC nunca firma por esta ruta: sin esta salida caería en la rama de firma
     * simple de abajo y firmaría sin pasar por Didit.
     */
    if (myParticipant.signatureType === SIGNATURE_TYPE_ENUM.BIOMETRIC) {
      throw new BadRequestException(
        'Este documento se firma con biometría. Inicia la firma con "Firmar con biometría".',
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

    await this.assertVerificationCode(
      document,
      myParticipant,
      VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
    );

    return this.completeSignature({
      document,
      participant: myParticipant,
      signerCollaborators,
      actor: currentUserId,
      geolocation,
      advancedSignatureResult,
      ipAddress: null,
      signingAuthorization: SIGNING_AUTHORIZATION_ENUM.ACCOUNT_SESSION,
    });
  }

  /**
   * Registra la firma biométrica respaldada por un intento que Didit aprobó.
   *
   * La invoca `ProcessBiometricSignatureResultUseCase` al recibir el webhook. Resuelve al firmante
   * por el `collaboratorId` del intento —no por un usuario—, así que sirve a firmantes con cuenta y
   * a invitados sin cuenta. Revalida todo lo que pudo cambiar desde que se abrió la sesión: estado
   * del documento, que el colaborador siga pendiente y en turno, y que el PDF sea el mismo.
   *
   * La ubicación y la IP son las que el firmante dio al iniciar; el veredicto biométrico queda en
   * el intento, que es la evidencia de esta firma.
   *
   * @param attemptId - Intento de `biometric_signature_attempts`, ya en APPROVED.
   * @returns El documento firmado y si esta firma lo dejó completo.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {BadRequestException} Si el intento no existe o no está aprobado, el PDF cambió, el
   *   colaborador ya no es firmante biométrico o ya respondió, el documento no está pendiente,
   *   falta el código que el documento exige, u otra entrega reclamó la firma primero.
   * @throws {ForbiddenException} Si ya no es su turno.
   *
   * @example
   * ```ts
   * await signDocument.executeBiometric('attempt-1');
   * ```
   */
  async executeBiometric(
    attemptId: string,
  ): Promise<BaseResponse<SignedDocumentData>> {
    const attempt = await this.biometricAttemptRepository.findOne({
      where: { id: attemptId },
    });

    if (
      !attempt ||
      attempt.status !== BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED
    ) {
      throw new BadRequestException(
        'La firma biométrica no está aprobada para este firmante',
      );
    }

    const document = await this.documentService.findOne(attempt.documentId);
    this.assertPendingSignature(document);

    if (attempt.documentHash !== document.originalHash) {
      throw new BadRequestException(
        'El documento cambió después de la verificación biométrica',
      );
    }

    const signerCollaborators = await this.collaboratorRepository.find({
      where: {
        documentId: document.id,
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      },
      relations: { account: { user: true }, simpleSignature: true },
      order: { signingOrder: 'ASC' },
    });
    const participant = signerCollaborators.find(
      (collaborator) => collaborator.id === attempt.collaboratorId,
    );

    /**
     * Firmante con cuenta: tiene que seguir siendo el mismo usuario. Invitado: el colaborador no
     * puede haber vinculado una cuenta entre medias (entonces firma como usuario, con su identidad).
     */
    const sameSigner = attempt.userId
      ? participant?.account?.userId === attempt.userId
      : !participant?.accountId;

    if (
      !participant ||
      participant.signatureType !== SIGNATURE_TYPE_ENUM.BIOMETRIC ||
      !sameSigner
    ) {
      throw new BadRequestException(
        'La firma biométrica no está aprobada para este firmante',
      );
    }

    this.assertCanRespond(document, participant, signerCollaborators);

    // El invitado acreditó su correo con el código de acceso; el usuario, con el código de firma.
    await this.assertVerificationCode(
      document,
      participant,
      attempt.userId
        ? VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT
        : VERIFICATION_EVENT_ENUM.GUEST_BIOMETRIC_ACCESS,
    );

    return this.completeSignature({
      document,
      participant,
      signerCollaborators,
      actor: attempt.userId ?? `guest-collaborator:${participant.id}`,
      geolocation: attempt.geolocation,
      advancedSignatureResult: null,
      ipAddress: attempt.ipAddress,
      signingAuthorization: attempt.userId
        ? SIGNING_AUTHORIZATION_ENUM.ACCOUNT_SESSION
        : SIGNING_AUTHORIZATION_ENUM.GUEST_EMAIL_OTP,
    });
  }

  /**
   * Registra la Firma Avanzada (FIEL) de un invitado sin cuenta, con el acceso temporal que obtuvo
   * al validar el código de su correo.
   *
   * Revalida justo antes de firmar todo lo que pudo cambiar desde que se emitió el acceso:
   *
   * 1. Geolocalización presente.
   * 2. Acceso activo (sin vencer, consumir ni revocar), de ESTE documento y ESTE colaborador, para
   *    Firma Avanzada.
   * 3. Documento pendiente de firma y con el mismo hash que el invitado revisó.
   * 4. Colaborador firmante FIEL, todavía sin cuenta vinculada, con el mismo correo al que se emitió
   *    el acceso, pendiente y en su turno.
   * 5. Certificado, llave y contraseña válidos (`EfirmaService`, antes del claim: una contraseña
   *    mal escrita no gasta el acceso).
   *
   * El claim consume el acceso, revoca los demás del colaborador y lo marca SIGNED en una sola
   * transacción, condicionada a que siga PENDING y sin cuenta: una firma por el dashboard y otra
   * por aquí no pueden ganar las dos.
   *
   * @param request - Acceso, documento, colaborador, hash revisado, e.firma, ubicación e IP.
   * @returns El documento firmado y si esta firma lo dejó completo.
   *
   * @throws {BadRequestException} Si falta la geolocalización o la e.firma, el documento no está
   *   pendiente o cambió, el colaborador ya respondió, falta el código que el documento exige, o
   *   la e.firma no es válida (los errores de `EfirmaService` se propagan tal cual).
   * @throws {InvalidGuestSigningAccessException} Si el acceso no está activo o no corresponde.
   * @throws {GuestAdvancedInvitationNotFoundException} Si el colaborador ya no es un firmante FIEL
   *   sin cuenta con el correo del acceso.
   * @throws {ForbiddenException} Si todavía no es su turno.
   *
   * @example
   * ```ts
   * await signDocument.executeGuestAdvanced({ accessId: 'a-1', documentId: 'd-1',
   *   collaboratorId: 'c-1', documentHash: 'abc…', advancedSignatureInput, geolocation,
   *   ipAddress: '10.0.0.1' });
   * ```
   */
  async executeGuestAdvanced(
    request: GuestAdvancedSignatureRequest,
  ): Promise<BaseResponse<SignedDocumentData>> {
    if (!request.geolocation) {
      throw new BadRequestException(
        'La geolocalización es obligatoria para poder firmar el documento',
      );
    }

    const access = await this.guestSigningAccessService.findActive(
      request.accessId,
    );
    if (
      !access ||
      access.documentId !== request.documentId ||
      access.collaboratorId !== request.collaboratorId ||
      access.purpose !==
        GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS
    ) {
      throw new InvalidGuestSigningAccessException();
    }

    const document = await this.documentService.findOne(request.documentId);
    this.assertPendingSignature(document);

    if (
      !document.originalHash ||
      request.documentHash !== document.originalHash
    ) {
      throw new BadRequestException(
        'El documento cambió desde que lo revisaste. Vuelve a abrirlo antes de firmar.',
      );
    }

    const signerCollaborators = await this.collaboratorRepository.find({
      where: {
        documentId: document.id,
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      },
      relations: { account: { user: true }, simpleSignature: true },
      order: { signingOrder: 'ASC' },
    });
    const participant = signerCollaborators.find(
      (collaborator) => collaborator.id === access.collaboratorId,
    );

    const isGuestAdvancedSigner =
      !!participant &&
      !participant.accountId &&
      participant.signatureType === SIGNATURE_TYPE_ENUM.FIEL &&
      !!participant.email &&
      hashInvitationEmail(participant.email) === access.emailHash;

    if (!isGuestAdvancedSigner) {
      throw new GuestAdvancedInvitationNotFoundException();
    }

    this.assertCanRespond(document, participant, signerCollaborators);

    const advancedSignatureResult =
      await this.documentService.validateAndSignWithEfirma(
        document,
        request.advancedSignatureInput,
      );

    await this.assertVerificationCode(
      document,
      participant,
      VERIFICATION_EVENT_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
    );

    return this.completeSignature({
      document,
      participant,
      signerCollaborators,
      actor: `guest-collaborator:${participant.id}`,
      geolocation: request.geolocation,
      advancedSignatureResult,
      ipAddress: request.ipAddress,
      signingAuthorization: SIGNING_AUTHORIZATION_ENUM.GUEST_EMAIL_OTP,
      guestAccessId: access.id,
    });
  }

  /**
   * Exige que el documento esté pendiente de firma.
   *
   * @param document - Documento que se firmaría.
   * @returns Nada.
   *
   * @throws {BadRequestException} Si el documento no está en `PENDING_SIGNATURE`.
   *
   * @example
   * ```ts
   * this.assertPendingSignature(document);
   * ```
   */
  private assertPendingSignature(document: DocumentEntity): void {
    if (document.status !== DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE) {
      throw new BadRequestException(
        `El documento no puede firmarse. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE}', el estatus actual es '${document.status}'`,
      );
    }
  }

  /**
   * Exige que el colaborador siga pendiente y, si el documento es secuencial, que sea su turno.
   *
   * @param document - Documento que se firma.
   * @param participant - Colaborador que firmaría.
   * @param signerCollaborators - Todos los firmantes del documento, para calcular el turno.
   * @returns Nada.
   *
   * @throws {BadRequestException} Si el colaborador ya respondió.
   * @throws {ForbiddenException} Si todavía no es su turno.
   *
   * @example
   * ```ts
   * this.assertCanRespond(document, participant, signers);
   * ```
   */
  private assertCanRespond(
    document: DocumentEntity,
    participant: CollaboratorEntity,
    signerCollaborators: CollaboratorEntity[],
  ): void {
    if (participant.status !== COLLABORATOR_STATUS_ENUM.PENDING) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }

    if (
      !isSignerTurn(participant, signerCollaborators, document.isSequential)
    ) {
      throw new ForbiddenException(
        'Aún no es tu turno para firmar este documento',
      );
    }
  }

  /**
   * Exige el código de verificación consumido cuando el documento lo pide (opt-in por documento:
   * apagado, el flujo de firma sigue igual que siempre).
   *
   * @param document - Documento que se firma.
   * @param participant - Colaborador que firmaría.
   * @param event - Qué código cuenta: el de firma, o el de acceso de un invitado biométrico.
   * @returns Nada.
   *
   * @throws {BadRequestException} Si el documento exige código y no hay uno consumido.
   *
   * @example
   * ```ts
   * await this.assertVerificationCode(document, participant, VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT);
   * ```
   */
  private async assertVerificationCode(
    document: DocumentEntity,
    participant: CollaboratorEntity,
    event: VERIFICATION_EVENT_ENUM,
  ): Promise<void> {
    if (!document.requiresVerification) {
      return;
    }

    const hasVerified = await this.verificationCodeService.hasConsumedCode(
      document.id,
      participant.id,
      event,
    );
    if (!hasVerified) {
      throw new BadRequestException(
        'Este documento requiere verificación. Solicita y valida tu código antes de firmar.',
      );
    }
  }

  /**
   * Claim de la firma de un invitado: consume su acceso, revoca los demás que tenga abiertos y lo
   * marca SIGNED, todo en una transacción.
   *
   * El `UPDATE` del colaborador va condicionado a `PENDING` y a `account_id IS NULL`: si entre la
   * validación y este punto alguien vinculó una cuenta a la invitación, o firmó por otra vía, no se
   * registra nada y el acceso tampoco queda consumido.
   *
   * @param collaboratorId - Colaborador que firma.
   * @param accessId - Acceso de invitado con el que firma.
   * @param resolvedAt - Momento de la firma.
   * @returns Nada.
   *
   * @throws {InvalidGuestSigningAccessException} Si el acceso dejó de estar activo.
   * @throws {BadRequestException} Si el colaborador ya respondió o ya tiene cuenta vinculada.
   *
   * @example
   * ```ts
   * await this.claimWithGuestAccess('c-1', 'a-1', new Date());
   * ```
   */
  private async claimWithGuestAccess(
    collaboratorId: string,
    accessId: string,
    resolvedAt: Date,
  ): Promise<void> {
    await this.collaboratorRepository.manager.transaction(async (manager) => {
      const consumed = await this.guestSigningAccessService.consume(
        manager,
        accessId,
      );
      if (!consumed) {
        throw new InvalidGuestSigningAccessException();
      }

      const claim = await manager.getRepository(CollaboratorEntity).update(
        {
          id: collaboratorId,
          status: COLLABORATOR_STATUS_ENUM.PENDING,
          accountId: IsNull(),
        },
        {
          status: COLLABORATOR_STATUS_ENUM.SIGNED,
          resolvedAt,
          signingAuthorization: SIGNING_AUTHORIZATION_ENUM.GUEST_EMAIL_OTP,
        },
      );
      if (claim.affected !== 1) {
        throw new BadRequestException(
          'Ya respondiste a esta solicitud de firma o la invitación quedó vinculada a una cuenta.',
        );
      }

      await revokeOpenGuestSigningAccesses(
        manager,
        collaboratorId,
        GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
      );
    });
  }

  /**
   * Corre una revocación de accesos de invitado sin dejar que su fallo tumbe una firma ya
   * reclamada.
   *
   * Revocar aquí es higiene, no la garantía: un acceso que quedara abierto no serviría, porque la
   * firma de invitado exige un colaborador PENDING y sin cuenta, y el documento pendiente.
   *
   * @param revoke - La revocación a ejecutar.
   * @returns Nada; un fallo se registra en el log.
   *
   * @example
   * ```ts
   * await this.revokeGuestAccessesQuietly(() => accesses.revokeOpenForDocument('d-1'));
   * ```
   */
  private async revokeGuestAccessesQuietly(
    revoke: () => Promise<number>,
  ): Promise<void> {
    try {
      await revoke();
    } catch (error) {
      this.logger.warn(
        `No se pudieron revocar accesos de invitado: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Del claim en adelante: reclama el turno, guarda la evidencia, finaliza o avisa al siguiente, y
   * publica eventos y auditoría. Común a las dos entradas.
   *
   * @param completion - Documento, colaborador, firmantes, actor y evidencia ya validados.
   * @returns El documento firmado y si esta firma lo dejó completo.
   *
   * @throws {BadRequestException} Si otra petición reclamó el turno primero.
   * @throws {Error} Lo que lancen el estampado, el sellado o MinIO al finalizar.
   *
   * @example
   * ```ts
   * return this.completeSignature({ document, participant, signerCollaborators, actor, geolocation,
   *   advancedSignatureResult: null, ipAddress: null });
   * ```
   */
  private async completeSignature({
    document,
    participant: myParticipant,
    signerCollaborators,
    actor,
    geolocation,
    advancedSignatureResult,
    ipAddress,
    signingAuthorization,
    guestAccessId,
  }: SignatureCompletion): Promise<BaseResponse<SignedDocumentData>> {
    const documentId = document.id;
    const resolvedAt = new Date();

    if (guestAccessId) {
      await this.claimWithGuestAccess(
        myParticipant.id,
        guestAccessId,
        resolvedAt,
      );
    } else {
      // `affected !== 1` significa que otra petición ya reclamó el turno.
      const claim = await this.collaboratorRepository.update(
        { id: myParticipant.id, status: COLLABORATOR_STATUS_ENUM.PENDING },
        {
          status: COLLABORATOR_STATUS_ENUM.SIGNED,
          resolvedAt,
          signingAuthorization,
        },
      );
      if (claim.affected !== 1) {
        throw new BadRequestException(
          'Ya respondiste a esta solicitud de firma',
        );
      }
      // Ya firmó: cualquier acceso de invitado que le quedara abierto sobra.
      await this.revokeGuestAccessesQuietly(() =>
        this.guestSigningAccessService.revokeOpenForCollaborator(
          myParticipant.id,
          GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
        ),
      );
    }
    myParticipant.status = COLLABORATOR_STATUS_ENUM.SIGNED;
    myParticipant.resolvedAt = resolvedAt;
    myParticipant.signingAuthorization = signingAuthorization;
    // Evidencia declarada por el dispositivo, no verificada por el servidor.
    myParticipant.geolocation = geolocation;
    if (ipAddress) {
      myParticipant.ipAddress = ipAddress;
    }

    if (myParticipant.signatureType === SIGNATURE_TYPE_ENUM.FIEL) {
      // Ya validado antes del claim; nunca contiene la llave privada ni la contraseña.
      myParticipant.advancedSignature = advancedSignatureResult;
    } else if (myParticipant.signatureType !== SIGNATURE_TYPE_ENUM.BIOMETRIC) {
      // Firma biométrica: no hay rúbrica que copiar. Su evidencia es el intento aprobado en
      // `biometric_signature_attempts` (veredicto mínimo de Didit, hash del PDF y ubicación).
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
        c.id !== myParticipant.id &&
        c.status === COLLABORATOR_STATUS_ENUM.PENDING,
    );

    document.completedSignersCount = (document.completedSignersCount ?? 0) + 1;

    if (remainingSigners.length === 0) {
      // Sella antes de armar la hoja de evidencia, para que la constancia NOM-151 quepa en ella.
      await this.documentService.finalizeSignedDocument(
        document,
        signerCollaborators,
      );
      // Documento completo: ningún acceso de invitado a él tiene ya sentido.
      await this.revokeGuestAccessesQuietly(() =>
        this.guestSigningAccessService.revokeOpenForDocument(documentId),
      );
      this.documentEventsProducer.emitSigned({
        documentId,
        fileName: document.fileName,
        actorUserId: actor,
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

    // Lo que este save persiste, a esta altura, es la geolocalización —y la IP en biométrica— y en
    // firma avanzada la firma electrónica. El claim atómico ya escribió status/signedAt y el
    // snapshot de la rúbrica se escribió apenas se tomó (ver arriba, lo necesita el sellado);
    // re-escribirlos con el mismo valor no tiene efecto.
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
      actorUserId: actor,
      collaboratorId: myParticipant.id,
      signedAt: myParticipant.resolvedAt.toISOString(),
    });

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_SIGNED,
      ipAddress: ipAddress ?? document.ipAddress ?? '0.0.0.0',
      users: [{ userId: actor, action: AuditAction.DOCUMENT_SIGNED }],
      signedAt: myParticipant.resolvedAt,
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

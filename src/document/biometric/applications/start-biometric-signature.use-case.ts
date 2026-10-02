import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { frontendBaseUrl } from 'src/common/utils/frontend-url.util';
import { DiditApiService } from 'src/identity-verification/didit/didit-api.service';
import { DiditConfigurationException } from 'src/identity-verification/exceptions/identity-verification.exceptions';

import { DocumentService } from '../../document.service';
import { VerificationCodeService } from '../../verification-code.service';
import { DocumentAuthorizationPolicy } from '../../policies/document-authorization.policy';
import { CollaboratorEntity } from '../../entities/collaborator.entity';
import { DocumentEntity } from '../../entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../../enum/collaborator-status.enum';
import { VERIFICATION_EVENT_ENUM } from '../../enum/verification-event.enum';
import { isSignerTurn } from '../../utils/next-signer.util';
import { GeolocationDto } from '../../dto/sign-document.dto';
import { BiometricSignatureAttemptEntity } from '../entities/biometric-signature-attempt.entity';
import { BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM } from '../enums/biometric-signature-attempt-status.enum';
import { BIOMETRIC_SIGNATURE_PROVIDER_ENUM } from '../enums/biometric-signature-provider.enum';
import { BiometricSignatureSession } from '../interfaces/biometric-signature-session.interface';
import { BiometricSignatureAttemptService } from '../services/biometric-signature-attempt.service';

const UNIQUE_VIOLATION = '23505';

/**
 * Inicia —o retoma— la firma biométrica de un documento: valida al firmante, deja el intento
 * local y abre la sesión de Didit (prueba de vida + face match).
 *
 * Es el ÚNICO lugar donde se crean sesiones biométricas de firma, y sólo corre cuando el firmante
 * pulsa "Firmar con biometría". Elegir `BIOMETRIC` al crear el documento no abre nada: una sesión
 * de Didit cuesta, vence y está atada al PDF que el firmante ve en ese momento.
 *
 * Esta llamada no firma. Mientras la biometría está en curso el colaborador sigue en `PENDING`; la
 * firma se registra cuando el webhook de Didit trae la aprobación (ver
 * `ProcessBiometricSignatureResultUseCase`).
 */
@Injectable()
export class StartBiometricSignatureUseCase {
  private readonly logger = new Logger(StartBiometricSignatureUseCase.name);

  constructor(
    @InjectRepository(BiometricSignatureAttemptEntity)
    private readonly attemptRepository: Repository<BiometricSignatureAttemptEntity>,
    private readonly attemptService: BiometricSignatureAttemptService,
    private readonly documentService: DocumentService,
    private readonly verificationCodeService: VerificationCodeService,
    private readonly authorizationPolicy: DocumentAuthorizationPolicy,
    private readonly diditApiService: DiditApiService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Devuelve la sesión biométrica con la que el firmante autoriza su firma.
   *
   * Si el colaborador ya tiene una sesión abierta, vigente y sobre el mismo PDF, la devuelve tal
   * cual (`reused: true`): recargar la página, o pasar de la computadora al celular, no abre otra.
   * Una sesión abierta que dejó de servir (venció o el PDF cambió) se cierra antes de crear la
   * nueva, para liberar el índice de "un intento abierto por colaborador".
   *
   * El intento local se persiste ANTES de llamar a Didit: si el proveedor responde y el proceso se
   * cae justo después, el webhook igual tiene con qué reconciliar.
   *
   * @param documentId - Documento que se quiere firmar.
   * @param userId - Usuario autenticado (`sub` del JWT).
   * @param geolocation - Ubicación del dispositivo; queda como evidencia de la firma.
   * @param authorization - Contexto que dejó `PermissionsGuard` para `DOCUMENT + SIGN`.
   * @returns La sesión: URL hospedada de Didit, estado del intento y si se reutilizó.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {BadRequestException} Si el documento no está pendiente de firma, el firmante ya
   *   respondió, su firma no es biométrica o falta el código de verificación que el documento exige.
   * @throws {ForbiddenException} Si el usuario no es firmante, no tiene `DOCUMENT.SIGN_SELF` o no es
   *   su turno.
   * @throws {ConflictException} Si otra petición abrió una sesión al mismo tiempo y ésta ya no es
   *   reutilizable.
   * @throws {DiditConfigurationException} Si falta `DIDIT_BIOMETRIC_WORKFLOW_ID` o la API key.
   * @throws {DiditResponseException} Si Didit no pudo crear la sesión (el intento queda en FAILED).
   *
   * @example
   * ```ts
   * const session = await startBiometricSignature.execute('doc-1', 'user-1', geolocation, auth);
   * // → { attemptId, status: 'PENDING', url: 'https://verify.didit.me/…', reused: false, … }
   * ```
   */
  async execute(
    documentId: string,
    userId: string,
    geolocation: GeolocationDto,
    authorization: AuthorizationContext,
  ): Promise<BiometricSignatureSession> {
    if (!geolocation) {
      throw new BadRequestException(
        'La geolocalización es obligatoria para poder firmar el documento',
      );
    }

    const document = await this.documentService.findOne(documentId);
    const signer = await this.resolveAuthorizedSigner(
      document,
      userId,
      authorization,
    );

    const active = await this.attemptService.findActive(signer.id);
    if (active) {
      if (this.attemptService.isResumable(active, document.originalHash)) {
        this.logger.log(
          `Reutilizando la sesión biométrica ${active.providerSessionId} del colaborador ${signer.id}.`,
        );
        return this.attemptService.toSession(active, {
          reused: true,
          signatureCompleted: false,
        });
      }

      await this.closeUnusable(active, document.originalHash);
    }

    const workflowId = this.configService.get<string>(
      'DIDIT_BIOMETRIC_WORKFLOW_ID',
    );
    if (!workflowId) {
      this.logger.error(
        'Falta DIDIT_BIOMETRIC_WORKFLOW_ID: no es posible abrir sesiones de firma biométrica.',
      );
      throw new DiditConfigurationException();
    }

    const attempt = await this.createAttempt(
      document,
      signer,
      userId,
      geolocation,
    );
    if (attempt.reusedSession) {
      return attempt.reusedSession;
    }

    try {
      const session = await this.diditApiService.createSession(
        userId,
        `${frontendBaseUrl()}/dashboard/documents/${documentId}`,
        { workflowId },
      );

      await this.attemptRepository.update(attempt.entity.id, {
        providerSessionId: session.sessionId,
        providerWorkflowId: session.workflowId,
        providerMetadata: { ...session.raw, hostedUrl: session.url },
        expiresAt: session.expiresAt,
      });
    } catch (error) {
      // El intento no se borra: queda en FAILED con el motivo, como rastro consultable.
      await this.attemptRepository.update(attempt.entity.id, {
        status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
        failureReason:
          error instanceof Error ? error.message : 'Error desconocido',
        completedAt: new Date(),
      });
      throw error;
    }

    return this.attemptService.toSession(
      await this.attemptRepository.findOneByOrFail({ id: attempt.entity.id }),
      { reused: false, signatureCompleted: false },
    );
  }

  /**
   * Comprueba que el usuario pueda firmar AHORA este documento con biometría.
   *
   * Son las mismas reglas que `SignDocumentUseCase` aplica antes de firmar —y que volverá a aplicar
   * cuando llegue la aprobación—, adelantadas para no gastar una sesión de Didit en una firma que
   * de todos modos se rechazaría.
   */
  private async resolveAuthorizedSigner(
    document: DocumentEntity,
    userId: string,
    authorization: AuthorizationContext,
  ): Promise<CollaboratorEntity> {
    if (document.status !== DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE) {
      throw new BadRequestException(
        `El documento no puede firmarse. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE}', el estatus actual es '${document.status}'`,
      );
    }

    const { signerCollaborators, myParticipant } =
      await this.documentService.findOrLinkMySignerCollaborator(
        document.id,
        userId,
        { account: true },
      );

    if (!myParticipant) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    this.authorizationPolicy.assertCanSign({
      document,
      authorization,
      participant: myParticipant,
    });

    if (myParticipant.signatureType !== SIGNATURE_TYPE_ENUM.BIOMETRIC) {
      throw new BadRequestException(
        'Tu firma en este documento no es biométrica',
      );
    }

    if (myParticipant.status !== COLLABORATOR_STATUS_ENUM.PENDING) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }

    if (
      !isSignerTurn(myParticipant, signerCollaborators, document.isSequential)
    ) {
      throw new ForbiddenException(
        'Aún no es tu turno para firmar este documento',
      );
    }

    if (document.requiresVerification) {
      const hasVerified = await this.verificationCodeService.hasConsumedCode(
        document.id,
        myParticipant.id,
        VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
      );
      if (!hasVerified) {
        throw new BadRequestException(
          'Este documento requiere verificación. Solicita y valida tu código antes de firmar.',
        );
      }
    }

    return myParticipant;
  }

  /**
   * Cierra un intento abierto que ya no puede retomarse, para que el colaborador pueda abrir otro.
   *
   * La condición `status` en el `UPDATE` evita pisar un webhook que haya cerrado el intento entre
   * la lectura y esta escritura.
   */
  private async closeUnusable(
    attempt: BiometricSignatureAttemptEntity,
    currentDocumentHash: string,
  ): Promise<void> {
    const expired = !this.attemptService.isUnexpired(attempt);
    const documentChanged = attempt.documentHash !== currentDocumentHash;

    await this.attemptRepository.update(
      { id: attempt.id, status: attempt.status },
      {
        status: expired
          ? BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.EXPIRED
          : BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
        failureReason: expired
          ? 'La sesión de Didit venció antes de completarse'
          : documentChanged
            ? 'El documento cambió después de iniciar la sesión biométrica'
            : 'La sesión de Didit quedó sin URL utilizable',
        completedAt: new Date(),
      },
    );
  }

  /**
   * Inserta el intento en PENDING. Si otra petición del mismo colaborador ganó la carrera, el
   * índice único parcial rechaza este `INSERT` y se devuelve la sesión de la ganadora.
   *
   * Un objeto con dos campos nulables y no una unión discriminada: el proyecto compila sin
   * `strictNullChecks`, y ahí TypeScript no estrecha uniones por un discriminante booleano.
   */
  private async createAttempt(
    document: DocumentEntity,
    signer: CollaboratorEntity,
    userId: string,
    geolocation: GeolocationDto,
  ): Promise<{
    entity: BiometricSignatureAttemptEntity | null;
    reusedSession: BiometricSignatureSession | null;
  }> {
    try {
      const entity = await this.attemptRepository.save(
        this.attemptRepository.create({
          documentId: document.id,
          collaboratorId: signer.id,
          userId,
          provider: BIOMETRIC_SIGNATURE_PROVIDER_ENUM.DIDIT,
          documentHash: document.originalHash,
          status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING,
          geolocation: { ...geolocation },
        }),
      );
      return { entity, reusedSession: null };
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }

      const winner = await this.attemptService.findActive(signer.id);
      if (!winner) {
        throw new ConflictException(
          'Se está iniciando otra sesión biométrica para esta firma. Inténtalo de nuevo.',
        );
      }

      return {
        entity: null,
        reusedSession: this.attemptService.toSession(winner, {
          reused: true,
          signatureCompleted: false,
        }),
      };
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string })?.code === UNIQUE_VIOLATION
    );
  }
}

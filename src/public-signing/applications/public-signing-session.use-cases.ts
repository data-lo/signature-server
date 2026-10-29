import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditService } from 'src/audit/audit.service';
import { AuditAction, AuditEvidence } from 'src/audit/schema/audit-document';
import { GetBiometricSignatureStatusUseCase } from 'src/biometric-signature/applications/get-biometric-signature-status.use-case';
import { BiometricSignatureSession } from 'src/biometric-signature/interfaces/biometric-signature-session.interface';
import { StartBiometricSignatureDto } from 'src/biometric-signature/dto/start-biometric-signature.dto';
import { StartGuestBiometricSignatureUseCase } from 'src/biometric-signature/applications/start-guest-biometric-signature.use-case';
import {
  SignDocumentUseCase,
  SignedDocumentData,
  toAuditActor,
} from 'src/document/applications/sign-document.use-case';
import { DocumentService } from 'src/document/document.service';
import { GeolocationDto } from 'src/document/dto/sign-document.dto';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { VERIFICATION_EVENT_ENUM } from 'src/document/enum/verification-event.enum';
import {
  SIGNING_VALIDATION_ERROR_CODE_ENUM,
  SigningValidationException,
} from 'src/document/exceptions/signing-validation.exceptions';
import { SigningRequestMetadata } from 'src/document/interfaces/signing-actor.interface';
import {
  collaboratorDisplayName,
  collaboratorEmail,
} from 'src/document/utils/collaborator-display.util';
import { VerificationCodeService } from 'src/document/verification-code.service';
import { maskEmail } from 'src/document/utils/mask-email.util';
import { isSignerTurn } from 'src/document/utils/next-signer.util';
import { CreateDiditSessionDto } from 'src/identity-verification/dto/create-didit-session.dto';
import { StartDiditVerificationUseCase } from 'src/identity-verification/applications/start-didit-verification.use-case';
import { StartedVerification } from 'src/identity-verification/interfaces/started-verification.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { UploadSignatureImageUseCase } from 'src/signature/applications/upload-signature-image.use-case';
import { SignaturePositionRecord } from 'src/signature/entities/simple-signature.entity';
import { InvalidSignatureImageException } from 'src/signature/exceptions/signature-capture.exceptions';
import { isPngBuffer } from 'src/signature/utils/png-file.util';
import {
  CERTIFICATE_ATTEMPTS,
  IDENTITY_VERIFICATION_START,
  SigningRateLimitService,
} from 'src/signing-invitation/signing-rate-limit.service';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';

import { signingErrorCode } from '../filters/public-signing-error.filter';
import { PublicSigningSessionContext } from '../interfaces/public-signing-session-context.interface';
import {
  IdentityAssessment,
  PublicSignerIdentityService,
} from '../services/public-signer-identity.service';
import {
  requireSigningIdempotencyKey,
  SigningIdempotencyService,
  signingRequestFingerprint,
} from '../services/signing-idempotency.service';
import {
  SigningPolicyResolver,
  SigningRequirements,
} from '../services/signing-policy.resolver';

/**
 * En qué punto está la sesión. `READY_TO_SIGN` sólo cuando se cumple todo lo que la política exige
 * antes del paso final (el certificado de la avanzada se valida al firmar).
 */
export type SigningSessionStatus =
  | 'READY_TO_SIGN'
  | 'SIGNED'
  | 'SIGNING_NOT_AVAILABLE'
  | 'IDENTITY_VERIFICATION_REQUIRED'
  | 'IDENTITY_VERIFICATION_REJECTED'
  | 'IDENTITY_DATA_MISMATCH';

/** Errores del certificado o de la firma criptográfica que se auditan como `CERTIFICATE_VALIDATION_FAILED`. */
const CERTIFICATE_ERROR_CODES: ReadonlySet<SIGNING_VALIDATION_ERROR_CODE_ENUM> =
  new Set([
    SIGNING_VALIDATION_ERROR_CODE_ENUM.CERTIFICATE_INVALID,
    SIGNING_VALIDATION_ERROR_CODE_ENUM.CERTIFICATE_REVOKED,
    SIGNING_VALIDATION_ERROR_CODE_ENUM.CERTIFICATE_SUBJECT_MISMATCH,
    SIGNING_VALIDATION_ERROR_CODE_ENUM.SIGNATURE_VALIDATION_FAILED,
  ]);

/** Una posición de firma del firmante, en ratios 0-1 de su página. */
export type SigningSessionPosition = Required<
  Pick<
    SignaturePositionRecord,
    'page' | 'xRatio' | 'yRatio' | 'widthRatio' | 'heightRatio'
  >
>;

/** Contexto completo de la sesión pública: lo que la pantalla necesita para firmar. */
export interface CurrentSigningSession {
  /** Si ya se puede firmar y, si no, por qué. */
  status: SigningSessionStatus;
  document: {
    name: string;
    status: DOCUMENT_STATUS_ENUM;
    totalPages: number;
    /** SHA-256 del PDF vigente; se devuelve al firmar para no firmar otra cosa. */
    documentHash: string | null;
  };
  signer: {
    name: string;
    emailMasked: string;
    /** @deprecated Igual a `emailMasked`; se conserva para clientes anteriores. */
    maskedEmail: string;
    /** Firma con el usuario provisional que se creó para la invitación (sin cuenta activa). */
    isProvisional: boolean;
    status: COLLABORATOR_STATUS_ENUM;
    /** El documento espera su firma y es su turno. */
    canSign: boolean;
    accountStatus: USER_LIFECYCLE_STATUS_ENUM | null;
  };
  signature: Omit<SigningRequirements, 'identityValidationReuse'> & {
    /** Ya verificado: la sesión se abrió con el código del correo. */
    emailVerified: true;
    /** Sólo firma simple: en qué paso está la credencial del usuario provisional. */
    credentialStatus: SIGNING_CREDENTIAL_STATUS_ENUM | null;
    /** Sólo firma simple: estado de la verificación de identidad. */
    identityVerification: IdentityAssessment | null;
  };
  positions: SigningSessionPosition[];
  session: { expiresAt: string };
}

/** URL temporal del PDF de la sesión. */
export interface CurrentSigningDocument {
  fileUrl: string;
  expiresIn: number;
  documentHash: string | null;
}

/** Firma pública simple o avanzada: lo que manda el cliente además de la sesión. */
export interface PublicSignatureInput {
  documentHash: string;
  geolocation?: GeolocationDto;
  idempotencyKey: string | undefined;
  metadata: SigningRequestMetadata;
}

/**
 * Posiciones explícitas del firmante, descartando las previas a los ratios (no se pueden ubicar
 * sin el tamaño de la página).
 *
 * @param collaborator - Firmante, con `simpleSignature` cargada.
 * @returns Sus posiciones, o `[]` si no tiene.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * signerPositions(collaborator); // [{ page: 1, xRatio: 0.1, yRatio: 0.8, widthRatio: 0.3, heightRatio: 0.1 }]
 * ```
 */
export function signerPositions(
  collaborator: CollaboratorEntity,
): SigningSessionPosition[] {
  return (collaborator.simpleSignature?.signatureCoordinates ?? [])
    .filter(
      (position): position is SignaturePositionRecord =>
        'xRatio' in position && typeof position.page === 'number',
    )
    .map(({ page, xRatio, yRatio, widthRatio, heightRatio }) => ({
      page,
      xRatio,
      yRatio,
      widthRatio,
      heightRatio,
    }));
}

/**
 * Estado de la sesión a partir de la disponibilidad y de la identidad del firmante.
 *
 * @param collaborator - Firmante.
 * @param canSign - Si el documento espera su firma y es su turno.
 * @param identity - Evaluación de su identidad (sólo firma simple).
 * @returns El estado.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * sessionStatus(collaborator, true, null); // 'READY_TO_SIGN'
 * ```
 */
export function sessionStatus(
  collaborator: CollaboratorEntity,
  canSign: boolean,
  identity: IdentityAssessment | null,
): SigningSessionStatus {
  if (collaborator.status === COLLABORATOR_STATUS_ENUM.SIGNED) return 'SIGNED';
  if (!canSign) return 'SIGNING_NOT_AVAILABLE';
  if (!identity || identity.satisfied) return 'READY_TO_SIGN';
  switch (identity.errorCode) {
    case SIGNING_VALIDATION_ERROR_CODE_ENUM.IDENTITY_VERIFICATION_REJECTED:
      return 'IDENTITY_VERIFICATION_REJECTED';
    case SIGNING_VALIDATION_ERROR_CODE_ENUM.IDENTITY_DATA_MISMATCH:
      return 'IDENTITY_DATA_MISMATCH';
    default:
      return 'IDENTITY_VERIFICATION_REQUIRED';
  }
}

/**
 * Lo que se hace dentro de una sesión pública de firma. Cada operación recibe el contexto que
 * resolvió `PublicSigningSessionGuard` y delega en lo que ya existe:
 *
 * - documento: `DocumentService.getDocumentMinioURL` (URL prefirmada);
 * - identidad de la firma simple: `StartDiditVerificationUseCase` sobre el usuario provisional;
 * - rúbrica: `UploadSignatureImageUseCase`;
 * - firma simple y avanzada: `SignDocumentUseCase.sign` con el actor `PUBLIC_INVITATION`;
 * - biometría: `StartGuestBiometricSignatureUseCase.executeForPublicSession`.
 *
 * Las firmas exigen `Idempotency-Key`.
 */
@Injectable()
export class PublicSigningSessionUseCases {
  constructor(
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly documentService: DocumentService,
    private readonly signDocument: SignDocumentUseCase,
    private readonly startDiditVerification: StartDiditVerificationUseCase,
    private readonly uploadSignatureImage: UploadSignatureImageUseCase,
    private readonly startGuestBiometric: StartGuestBiometricSignatureUseCase,
    private readonly idempotency: SigningIdempotencyService,
    private readonly getBiometricStatus: GetBiometricSignatureStatusUseCase,
    private readonly auditService: AuditService,
    private readonly policy: SigningPolicyResolver,
    private readonly identity: PublicSignerIdentityService,
    private readonly verificationCodeService: VerificationCodeService,
    private readonly limits: SigningRateLimitService,
  ) {}

  /**
   * Estado del último intento biométrico del firmante de la sesión, para sondear el resultado de
   * Didit sin token de invitado.
   *
   * @param session - Contexto del guard.
   * @returns La sesión del último intento, o `null` si nunca inició una.
   *
   * @throws {BadRequestException} Si el firmante no es biométrico.
   *
   * @example
   * ```ts
   * const attempt = await sessions.biometricStatus(session);
   * ```
   */
  biometricStatus(
    session: PublicSigningSessionContext,
  ): Promise<BiometricSignatureSession | null> {
    if (session.collaborator.signatureType !== SIGNATURE_TYPE_ENUM.BIOMETRIC) {
      throw new BadRequestException(
        'Este documento no se firma con biometría.',
      );
    }
    return this.getBiometricStatus.forPublicSession(
      session.document.id,
      session.collaborator.id,
    );
  }

  /**
   * Contexto completo de la sesión: documento, firmante, tipo de firma con sus pasos y posiciones.
   *
   * @param session - Contexto del guard.
   * @returns El contexto de la sesión.
   *
   * @throws Nada propio; errores de la base.
   *
   * @example
   * ```ts
   * const current = await sessions.current(session);
   * ```
   */
  async current(
    session: PublicSigningSessionContext,
  ): Promise<CurrentSigningSession> {
    const { document, collaborator } = session;
    const canSign = await this.isAvailable(session);
    const requirements = this.policy.resolve(document, collaborator);
    const { identityValidationReuse, ...signatureRequirements } = requirements;
    void identityValidationReuse; // Regla interna: la pantalla no la necesita.
    const user = collaborator.account?.user ?? null;
    const isSimple = collaborator.signatureType === SIGNATURE_TYPE_ENUM.SIMPLE;
    const identityVerification =
      isSimple && user
        ? await this.identity.assess(
            user,
            collaboratorDisplayName(collaborator),
            requirements,
          )
        : null;
    const emailMasked = maskEmail(collaboratorEmail(collaborator));

    return {
      status: sessionStatus(collaborator, canSign, identityVerification),
      document: {
        name: document.fileName,
        status: document.status,
        totalPages: document.totalPages,
        documentHash: document.originalHash ?? null,
      },
      signer: {
        name: collaboratorDisplayName(collaborator),
        emailMasked,
        maskedEmail: emailMasked,
        isProvisional:
          user?.lifecycleStatus === USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
        status: collaborator.status,
        canSign,
        accountStatus: user?.lifecycleStatus ?? null,
      },
      signature: {
        ...signatureRequirements,
        emailVerified: true,
        credentialStatus: isSimple
          ? (user?.signingCredentialStatus ?? null)
          : null,
        identityVerification,
      },
      positions: signerPositions(collaborator),
      session: { expiresAt: session.expiresAt.toISOString() },
    };
  }

  /**
   * Estado de la verificación de identidad del firmante simple, para sondear el resultado de Didit
   * mientras la pantalla espera.
   *
   * @param session - Contexto del guard.
   * @returns La evaluación de su identidad contra la política.
   *
   * @throws {BadRequestException} Si el firmante no es de firma simple con usuario provisional.
   *
   * @example
   * ```ts
   * const { status, satisfied } = await sessions.identityVerification(session);
   * ```
   */
  identityVerification(
    session: PublicSigningSessionContext,
  ): Promise<IdentityAssessment> {
    this.requireSimpleSigner(session);
    return this.identity.assess(
      session.collaborator.account!.user,
      collaboratorDisplayName(session.collaborator),
      this.policy.resolve(session.document, session.collaborator),
    );
  }

  /**
   * URL temporal del PDF. Sólo con sesión —el código del correo ya se validó— y sólo de un
   * documento que ya salió a firma.
   *
   * @param session - Contexto del guard.
   * @returns URL prefirmada, su vigencia y el hash del PDF.
   *
   * @throws {NotFoundException} Si el documento todavía no sale a firma.
   *
   * @example
   * ```ts
   * const { fileUrl } = await sessions.document(session);
   * ```
   */
  async document(
    session: PublicSigningSessionContext,
  ): Promise<CurrentSigningDocument> {
    const { document } = session;
    if (
      [
        DOCUMENT_STATUS_ENUM.CREATED,
        DOCUMENT_STATUS_ENUM.PENDING_APPROVAL,
      ].includes(document.status)
    ) {
      throw new NotFoundException('El documento todavía no está disponible.');
    }

    const file = await this.documentService.getDocumentMinioURL(document.id);
    return {
      fileUrl: file.secureUrl,
      expiresIn: file.expiresIn,
      documentHash: document.originalHash ?? null,
    };
  }

  /**
   * Abre (o retoma) la verificación de identidad de Didit del usuario provisional, el paso previo
   * de la firma simple pública. Limitada por firmante (`IDENTITY_VERIFICATION_START`) y auditada
   * como `IDENTITY_VERIFICATION_STARTED`, con el intento y el proveedor como evidencia.
   *
   * @param session - Contexto del guard.
   * @param dto - Ruta del frontend a la que vuelve Didit.
   * @param metadata - IP y user-agent.
   * @returns La verificación iniciada (URL hospedada de Didit).
   *
   * @throws {SigningValidationException} `SIGNING_NOT_AVAILABLE` si todavía no puede firmar.
   * @throws {BadRequestException} Si el firmante no es de firma simple con usuario provisional.
   * @throws {SigningRateLimitException} (429) Si inició demasiadas verificaciones.
   * @throws Lo que lance `StartDiditVerificationUseCase` (identidad ya aprobada, bloqueada…).
   *
   * @example
   * ```ts
   * await sessions.startIdentityVerification(session, { returnPath: '/sign/session' }, metadata);
   * ```
   */
  async startIdentityVerification(
    session: PublicSigningSessionContext,
    dto: CreateDiditSessionDto,
    metadata: SigningRequestMetadata,
  ): Promise<StartedVerification> {
    const userId = this.requireSimpleSigner(session);
    await this.assertAvailable(session);
    await this.limits.consume(`collab:${session.collaborator.id}`, [
      IDENTITY_VERIFICATION_START,
    ]);

    try {
      const started = await this.startDiditVerification.execute(userId, dto);
      this.audit(
        session,
        metadata,
        AuditAction.IDENTITY_VERIFICATION_STARTED,
        'SUCCESS',
        {
          identityProvider: 'DIDIT',
          identityVerificationId: started.verificationId,
        },
      );
      return started;
    } catch (error) {
      this.audit(
        session,
        metadata,
        AuditAction.IDENTITY_VERIFICATION_STARTED,
        'FAILURE',
        { identityProvider: 'DIDIT' },
      );
      throw error;
    }
  }

  /**
   * Firma simple pública. Si el usuario provisional todavía no tiene rúbrica (credencial en
   * `SIGNATURE_PENDING`), la imagen PNG que manda se registra primero como su firma; si ya la tiene,
   * se usa ésa.
   *
   * @param session - Contexto del guard.
   * @param input - Hash revisado, ubicación, `Idempotency-Key` y evidencia.
   * @param signatureImage - Rúbrica dibujada (PNG); obligatoria sólo sin rúbrica registrada.
   * @returns El documento firmado y si quedó completo (o la respuesta guardada de un reintento).
   *
   * @throws {BadRequestException} Falta la clave, el firmante no es de firma simple, falta la rúbrica
   *   o no es PNG, o lo que rechace la firma (ver `SignDocumentUseCase.sign`).
   *
   * @example
   * ```ts
   * await sessions.signSimple(session, { documentHash, geolocation, idempotencyKey, metadata }, png);
   * ```
   */
  signSimple(
    session: PublicSigningSessionContext,
    input: PublicSignatureInput,
    signatureImage: Express.Multer.File | undefined,
  ): Promise<BaseResponse<SignedDocumentData>> {
    const idempotencyKey = requireSigningIdempotencyKey(input.idempotencyKey);
    const fingerprint = signingRequestFingerprint(
      'simple',
      { documentHash: input.documentHash, geolocation: input.geolocation },
      [signatureImage],
    );

    return this.runSigning(
      session,
      input.metadata,
      idempotencyKey,
      fingerprint,
      async () => {
        const userId = this.requireSimpleSigner(session);
        await this.assertReadyToSign(session, input.metadata);
        const credential =
          session.collaborator.account?.user?.signingCredentialStatus;
        if (credential === SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING) {
          if (!signatureImage || !isPngBuffer(signatureImage.buffer)) {
            throw new InvalidSignatureImageException(
              'Dibuja tu firma: se requiere la imagen PNG de tu rúbrica.',
            );
          }
          await this.uploadSignatureImage.execute(
            userId,
            { signatureImage },
            { signatureImage: [signatureImage] },
          );
        }

        return this.signDocument.sign(
          session.actor,
          {
            documentId: session.document.id,
            geolocation: input.geolocation,
            documentHash: input.documentHash,
            metadata: input.metadata,
          },
          SIGNATURE_TYPE_ENUM.SIMPLE,
        );
      },
    );
  }

  /**
   * Firma Electrónica Avanzada pública con `.cer`, `.key` y contraseña.
   *
   * @param session - Contexto del guard.
   * @param input - Hash revisado, ubicación, `Idempotency-Key` y evidencia.
   * @param efirma - Llave, certificado y contraseña. La contraseña no entra en la huella.
   * @returns El documento firmado y si quedó completo (o la respuesta guardada de un reintento).
   *
   * @throws {BadRequestException} Falta la clave, el firmante no es FIEL, o lo que rechace la firma.
   * @throws {UnprocessableEntityException} Si la e.firma no es válida (mensaje de `EfirmaService`).
   *
   * @example
   * ```ts
   * await sessions.signAdvanced(session, input, { keyFile, cerFile, password });
   * ```
   */
  signAdvanced(
    session: PublicSigningSessionContext,
    input: PublicSignatureInput,
    efirma: {
      keyFile?: Express.Multer.File;
      cerFile?: Express.Multer.File;
      password?: string;
    },
  ): Promise<BaseResponse<SignedDocumentData>> {
    const idempotencyKey = requireSigningIdempotencyKey(input.idempotencyKey);
    const fingerprint = signingRequestFingerprint(
      'advanced',
      { documentHash: input.documentHash, geolocation: input.geolocation },
      [efirma.keyFile, efirma.cerFile],
    );

    return this.runSigning(
      session,
      input.metadata,
      idempotencyKey,
      fingerprint,
      async () => {
        if (session.collaborator.signatureType !== SIGNATURE_TYPE_ENUM.FIEL) {
          throw new BadRequestException(
            'Este documento no se firma con e.firma.',
          );
        }
        await this.assertReadyToSign(session, input.metadata);
        await this.limits.consume(`collab:${session.collaborator.id}`, [
          CERTIFICATE_ATTEMPTS,
        ]);

        const { certificateRequirements } = this.policy.resolve(
          session.document,
          session.collaborator,
        );
        try {
          return await this.signDocument.sign(
            session.actor,
            {
              documentId: session.document.id,
              advancedSignatureInput: efirma,
              geolocation: input.geolocation,
              documentHash: input.documentHash,
              metadata: input.metadata,
              ...(certificateRequirements?.validateSubjectMatch
                ? {
                    expectedCertificateSubject: {
                      taxId: session.collaborator.taxId ?? null,
                      fullName: collaboratorDisplayName(session.collaborator),
                    },
                  }
                : {}),
            },
            SIGNATURE_TYPE_ENUM.FIEL,
          );
        } catch (error) {
          const code = signingErrorCode(error);
          if (code && CERTIFICATE_ERROR_CODES.has(code)) {
            this.audit(
              session,
              input.metadata,
              AuditAction.CERTIFICATE_VALIDATION_FAILED,
              'FAILURE',
              { errorCode: code, documentHash: input.documentHash },
            );
          }
          throw error;
        }
      },
    );
  }

  /**
   * Firma biométrica pública: abre (o retoma) la sesión de Didit. La firma se registra después,
   * con el webhook de Didit, igual que para cualquier firmante biométrico.
   *
   * @param session - Contexto del guard.
   * @param dto - Consentimiento y ubicación.
   * @param idempotencyKey - Header `Idempotency-Key`.
   * @param metadata - IP y user-agent.
   * @returns La sesión de Didit.
   *
   * @throws {BadRequestException} Falta la clave o el firmante no es biométrico.
   *
   * @example
   * ```ts
   * await sessions.signBiometric(session, dto, key, metadata);
   * ```
   */
  signBiometric(
    session: PublicSigningSessionContext,
    dto: StartBiometricSignatureDto,
    idempotencyKey: string | undefined,
    metadata: SigningRequestMetadata,
  ): Promise<BiometricSignatureSession> {
    const key = requireSigningIdempotencyKey(idempotencyKey);
    const fingerprint = signingRequestFingerprint('biometric', {
      geolocation: dto.geolocation,
    });

    return this.runSigning(session, metadata, key, fingerprint, () => {
      if (
        session.collaborator.signatureType !== SIGNATURE_TYPE_ENUM.BIOMETRIC
      ) {
        throw new BadRequestException(
          'Este documento no se firma con biometría.',
        );
      }
      return this.startGuestBiometric.executeForPublicSession(
        session.document.id,
        session.collaborator.id,
        dto,
        metadata.ipAddress,
      );
    });
  }

  /**
   * Ejecuta una firma una sola vez por `Idempotency-Key` y la audita: `SIGNING_STARTED` al
   * intentarla y `SIGNING_FAILED` si falla (la firma exitosa ya la audita `SignDocumentUseCase`
   * como `DOCUMENT_SIGNED`). Un reintento que devuelve la respuesta guardada no vuelve a auditar.
   *
   * @param session - Contexto del guard.
   * @param metadata - IP y user-agent.
   * @param idempotencyKey - Clave ya validada.
   * @param fingerprint - Huella de la petición.
   * @param operation - La firma.
   * @returns Lo que devuelva la firma (o su respuesta guardada).
   *
   * @throws Lo que lance la firma, después de auditar el fallo.
   *
   * @example
   * ```ts
   * await this.runSigning(session, metadata, key, fingerprint, () => this.signDocument.sign(…));
   * ```
   */
  private runSigning<T>(
    session: PublicSigningSessionContext,
    metadata: SigningRequestMetadata,
    idempotencyKey: string,
    fingerprint: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.idempotency.run(
      session.collaborator.id,
      idempotencyKey,
      fingerprint,
      async () => {
        this.audit(session, metadata, AuditAction.SIGNING_STARTED, 'SUCCESS');
        try {
          return await operation();
        } catch (error) {
          this.audit(session, metadata, AuditAction.SIGNING_FAILED, 'FAILURE');
          throw error;
        }
      },
    );
  }

  /**
   * Revalida, justo antes de la firma final, todo lo que la política exige: que el documento siga
   * esperando la firma de este colaborador en su turno, el código del correo y —firma simple— la
   * identidad aprobada con datos que correspondan (auditado como `IDENTITY_VERIFICATION_CHECKED`).
   *
   * @param session - Contexto del guard.
   * @param metadata - IP y user-agent.
   * @returns Nada.
   *
   * @throws {SigningValidationException} `SIGNING_NOT_AVAILABLE`, `EMAIL_VERIFICATION_REQUIRED`,
   *   `IDENTITY_VERIFICATION_REQUIRED`, `IDENTITY_VERIFICATION_REJECTED` o `IDENTITY_DATA_MISMATCH`.
   *
   * @example
   * ```ts
   * await this.assertReadyToSign(session, metadata);
   * ```
   */
  private async assertReadyToSign(
    session: PublicSigningSessionContext,
    metadata: SigningRequestMetadata,
  ): Promise<void> {
    const { document, collaborator } = session;
    await this.assertAvailable(session);
    const requirements = this.policy.resolve(document, collaborator);

    if (
      requirements.requiresEmailVerification &&
      !(await this.verificationCodeService.hasConsumedCode(
        document.id,
        collaborator.id,
        VERIFICATION_EVENT_ENUM.PUBLIC_SIGNING_ACCESS,
      ))
    ) {
      throw new SigningValidationException(
        SIGNING_VALIDATION_ERROR_CODE_ENUM.EMAIL_VERIFICATION_REQUIRED,
        'Valida el código que enviamos a tu correo antes de firmar.',
      );
    }

    if (
      requirements.requiresIdentityValidation &&
      requirements.identityProvider === 'DIDIT' &&
      requirements.type === 'SIMPLE'
    ) {
      try {
        const assessment = await this.identity.assertSatisfied(
          collaborator.account!.user,
          collaboratorDisplayName(collaborator),
          requirements,
        );
        this.audit(
          session,
          metadata,
          AuditAction.IDENTITY_VERIFICATION_CHECKED,
          'SUCCESS',
          {
            identityProvider: 'DIDIT',
            identityVerificationId: assessment.verificationId,
          },
        );
      } catch (error) {
        this.audit(
          session,
          metadata,
          AuditAction.IDENTITY_VERIFICATION_CHECKED,
          'FAILURE',
          { identityProvider: 'DIDIT', errorCode: signingErrorCode(error) },
        );
        throw error;
      }
    }
  }

  /**
   * Exige que el documento espere la firma del colaborador y que sea su turno.
   *
   * @param session - Contexto del guard.
   * @returns Nada.
   *
   * @throws {SigningValidationException} `SIGNING_NOT_AVAILABLE`.
   */
  private async assertAvailable(
    session: PublicSigningSessionContext,
  ): Promise<void> {
    if (!(await this.isAvailable(session))) {
      throw new SigningValidationException(
        SIGNING_VALIDATION_ERROR_CODE_ENUM.SIGNING_NOT_AVAILABLE,
        session.collaborator.status === COLLABORATOR_STATUS_ENUM.PENDING
          ? 'Todavía no puedes firmar este documento: espera tu turno.'
          : 'Ya respondiste a esta solicitud de firma.',
      );
    }
  }

  /**
   * Si el documento espera la firma del colaborador y es su turno (secuencial) o basta con que
   * esté pendiente (no secuencial).
   *
   * @param session - Contexto del guard.
   * @returns `true` si puede firmar ahora.
   */
  private async isAvailable(
    session: PublicSigningSessionContext,
  ): Promise<boolean> {
    const { document, collaborator } = session;
    if (
      document.status !== DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE ||
      collaborator.status !== COLLABORATOR_STATUS_ENUM.PENDING
    ) {
      return false;
    }
    if (!document.isSequential) return true;

    const signers = await this.collaboratorRepository.find({
      where: {
        documentId: document.id,
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      },
      order: { signingOrder: 'ASC' },
    });
    return isSignerTurn(collaborator, signers, document.isSequential);
  }

  private audit(
    session: PublicSigningSessionContext,
    metadata: SigningRequestMetadata,
    operation: AuditAction,
    result: 'SUCCESS' | 'FAILURE',
    evidence?: AuditEvidence,
  ): void {
    void this.auditService.create({
      documentId: session.document.id,
      operation,
      ipAddress: metadata.ipAddress ?? '0.0.0.0',
      actor: toAuditActor(session.actor, metadata.userAgent),
      result,
      ...(evidence ? { evidence } : {}),
    });
  }

  /**
   * Usuario provisional de un firmante de firma simple.
   *
   * @param session - Contexto del guard.
   * @returns Su `userId`.
   *
   * @throws {BadRequestException} Si el firmante no es SIMPLE o no tiene usuario vinculado.
   */
  private requireSimpleSigner(session: PublicSigningSessionContext): string {
    if (
      session.collaborator.signatureType !== SIGNATURE_TYPE_ENUM.SIMPLE ||
      !session.actor.userId
    ) {
      throw new BadRequestException(
        'Este documento no se firma con firma simple.',
      );
    }
    return session.actor.userId;
  }
}

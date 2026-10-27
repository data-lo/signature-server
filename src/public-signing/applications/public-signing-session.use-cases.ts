import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BiometricSignatureSession } from 'src/biometric-signature/interfaces/biometric-signature-session.interface';
import { StartBiometricSignatureDto } from 'src/biometric-signature/dto/start-biometric-signature.dto';
import { StartGuestBiometricSignatureUseCase } from 'src/biometric-signature/applications/start-guest-biometric-signature.use-case';
import {
  SignDocumentUseCase,
  SignedDocumentData,
} from 'src/document/applications/sign-document.use-case';
import { DocumentService } from 'src/document/document.service';
import { GeolocationDto } from 'src/document/dto/sign-document.dto';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { SigningRequestMetadata } from 'src/document/interfaces/signing-actor.interface';
import { collaboratorEmail } from 'src/document/utils/collaborator-display.util';
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
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';

import { PublicSigningSessionContext } from '../interfaces/public-signing-session-context.interface';
import {
  requireSigningIdempotencyKey,
  SigningIdempotencyService,
  signingRequestFingerprint,
} from '../services/signing-idempotency.service';

/** Una posición de firma del firmante, en ratios 0-1 de su página. */
export type SigningSessionPosition = Required<
  Pick<
    SignaturePositionRecord,
    'page' | 'xRatio' | 'yRatio' | 'widthRatio' | 'heightRatio'
  >
>;

/** Contexto completo de la sesión pública: lo que la pantalla necesita para firmar. */
export interface CurrentSigningSession {
  document: {
    name: string;
    status: DOCUMENT_STATUS_ENUM;
    totalPages: number;
    /** SHA-256 del PDF vigente; se devuelve al firmar para no firmar otra cosa. */
    documentHash: string | null;
  };
  signer: {
    maskedEmail: string;
    status: COLLABORATOR_STATUS_ENUM;
    /** El documento espera su firma y es su turno. */
    canSign: boolean;
    accountStatus: USER_LIFECYCLE_STATUS_ENUM | null;
  };
  signature: {
    type: SIGNATURE_TYPE_ENUM;
    /** Ya verificado: la sesión se abrió con el código del correo. */
    emailVerified: true;
    requiresIdentityValidation: boolean;
    /** Sólo firma simple: en qué paso está la credencial del usuario provisional. */
    credentialStatus: SIGNING_CREDENTIAL_STATUS_ENUM | null;
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
  ) {}

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
    const signers = await this.collaboratorRepository.find({
      where: {
        documentId: document.id,
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      },
      order: { signingOrder: 'ASC' },
    });
    const type = collaborator.signatureType!;
    const user = collaborator.account?.user ?? null;

    return {
      document: {
        name: document.fileName,
        status: document.status,
        totalPages: document.totalPages,
        documentHash: document.originalHash ?? null,
      },
      signer: {
        maskedEmail: maskEmail(collaboratorEmail(collaborator)),
        status: collaborator.status,
        canSign:
          document.status === DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE &&
          collaborator.status === COLLABORATOR_STATUS_ENUM.PENDING &&
          isSignerTurn(collaborator, signers, document.isSequential),
        accountStatus: user?.lifecycleStatus ?? null,
      },
      signature: {
        type,
        emailVerified: true,
        requiresIdentityValidation:
          type === SIGNATURE_TYPE_ENUM.BIOMETRIC ||
          type === SIGNATURE_TYPE_ENUM.SIMPLE,
        credentialStatus:
          type === SIGNATURE_TYPE_ENUM.SIMPLE
            ? (user?.signingCredentialStatus ?? null)
            : null,
      },
      positions: signerPositions(collaborator),
      session: { expiresAt: session.expiresAt.toISOString() },
    };
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
   * de la firma simple pública.
   *
   * @param session - Contexto del guard.
   * @param dto - Ruta del frontend a la que vuelve Didit.
   * @returns La verificación iniciada (URL hospedada de Didit).
   *
   * @throws {BadRequestException} Si el firmante no es de firma simple con usuario provisional.
   * @throws Lo que lance `StartDiditVerificationUseCase` (identidad ya aprobada, bloqueada…).
   *
   * @example
   * ```ts
   * await sessions.verifyIdentity(session, { returnPath: '/sign/session' });
   * ```
   */
  verifyIdentity(
    session: PublicSigningSessionContext,
    dto: CreateDiditSessionDto,
  ): Promise<StartedVerification> {
    const userId = this.requireSimpleSigner(session);
    return this.startDiditVerification.execute(userId, dto);
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

    return this.idempotency.run(
      session.collaborator.id,
      idempotencyKey,
      fingerprint,
      async () => {
        const userId = this.requireSimpleSigner(session);
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

    return this.idempotency.run(
      session.collaborator.id,
      idempotencyKey,
      fingerprint,
      () =>
        this.signDocument.sign(
          session.actor,
          {
            documentId: session.document.id,
            advancedSignatureInput: efirma,
            geolocation: input.geolocation,
            documentHash: input.documentHash,
            metadata: input.metadata,
          },
          SIGNATURE_TYPE_ENUM.FIEL,
        ),
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

    return this.idempotency.run(
      session.collaborator.id,
      key,
      fingerprint,
      () => {
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
      },
    );
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

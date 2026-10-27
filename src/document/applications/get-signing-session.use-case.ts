import { Injectable, NotFoundException } from '@nestjs/common';

import { SignaturePositionRecord } from 'src/signature/entities/simple-signature.entity';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';

import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { SigningInvitationEntity } from '../entities/signing-invitation.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { SIGNING_SESSION_STATUS_ENUM } from '../enum/signing-session-status.enum';
import { SigningInvitationService } from '../services/signing-invitation.service';
import { summarizeSigningInvitation } from './get-public-signing-invitation.use-case';

/** Documentos cancelados o en proceso de cancelación. */
const CANCELLED_DOCUMENT_STATUSES: ReadonlySet<DOCUMENT_STATUS_ENUM> = new Set([
  DOCUMENT_STATUS_ENUM.CANCELLED,
  DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING,
]);

/** Una posición de firma del firmante, en ratios 0-1 de su página. */
export type SigningSessionPosition = Required<
  Pick<
    SignaturePositionRecord,
    'page' | 'xRatio' | 'yRatio' | 'widthRatio' | 'heightRatio'
  >
>;

/** Sesión de firma abierta con un token de invitación. */
export interface SigningSession {
  status: SIGNING_SESSION_STATUS_ENUM;
  /** Sólo con `ACTIVE`. */
  document?: {
    /** Lo usan los flujos de invitado (código al correo, documento, firma), que van por documento. */
    id: string;
    name: string;
  };
  /** Sólo con `ACTIVE`. */
  signer?: {
    collaboratorId: string;
    /** Correo invitado, enmascarado (`a***@empresa.com`). */
    maskedEmail: string;
    /** Ciclo de vida del usuario de la cuenta vinculada; `null` si el firmante no tiene cuenta. */
    accountStatus: USER_LIFECYCLE_STATUS_ENUM | null;
    /** Puede firmar sin cuenta: no tiene cuenta vinculada y su tipo de firma lo admite. */
    guestSigningAllowed: boolean;
  };
  /** Sólo con `ACTIVE`. */
  signature?: {
    type: SIGNATURE_TYPE_ENUM;
    /** Todo firmante acredita su correo con un código antes de firmar. */
    requiresEmailVerification: boolean;
    /** Verificación de identidad (Didit) antes de firmar: hoy, sólo la biométrica. */
    requiresIdentityValidation: boolean;
  };
  /** Sólo con `ACTIVE`: dónde se estampará su firma. */
  positions?: SigningSessionPosition[];
  /** Sólo con `ACTIVE`: vencimiento de la invitación (ISO 8601). */
  expiresAt?: string;
}

/**
 * Posiciones explícitas del firmante, descartando las que se guardaron antes de las posiciones en
 * ratios (no se pueden ubicar sin el tamaño de la página).
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
function signerPositions(
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
 * Estado de la invitación, del más definitivo al menos: revocada y vencida primero —un enlace
 * muerto no dice nada del documento—, luego lo que ya pasó con el firmante y con el documento.
 *
 * @param invitation - Invitación encontrada.
 * @param document - Su documento.
 * @param collaborator - Su firmante.
 * @param now - Instante de referencia.
 * @returns El estado de la sesión.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * resolveSigningSessionStatus(invitation, document, collaborator, new Date()); // 'ACTIVE'
 * ```
 */
export function resolveSigningSessionStatus(
  invitation: SigningInvitationEntity,
  document: DocumentEntity,
  collaborator: CollaboratorEntity,
  now: Date,
): SIGNING_SESSION_STATUS_ENUM {
  if (invitation.revokedAt) return SIGNING_SESSION_STATUS_ENUM.REVOKED;
  if (invitation.expiresAt.getTime() <= now.getTime()) {
    return SIGNING_SESSION_STATUS_ENUM.EXPIRED;
  }
  if (
    collaborator.status === COLLABORATOR_STATUS_ENUM.SIGNED ||
    document.status === DOCUMENT_STATUS_ENUM.SIGNED
  ) {
    return SIGNING_SESSION_STATUS_ENUM.ALREADY_SIGNED;
  }
  if (CANCELLED_DOCUMENT_STATUSES.has(document.status)) {
    return SIGNING_SESSION_STATUS_ENUM.DOCUMENT_CANCELLED;
  }
  if (!summarizeSigningInvitation(document, collaborator).availableForSigning) {
    return SIGNING_SESSION_STATUS_ENUM.UNAVAILABLE;
  }
  return SIGNING_SESSION_STATUS_ENUM.ACTIVE;
}

/**
 * `GET /public/signing-sessions/:token`: resuelve la invitación individual de un firmante para la
 * pantalla pública `/sign/:token`.
 *
 * Todo sale del backend: el documento, el firmante, su correo (enmascarado), su cuenta y el tipo de
 * firma. La pantalla no puede cambiar ninguno, porque no manda nada más que el token.
 *
 * Una invitación que ya no sirve (vencida, revocada, de un documento firmado, cancelado o no
 * disponible) responde sólo su estado, sin nombre del documento ni datos del firmante. Nada de esto
 * da acceso al PDF: para verlo y firmar, el firmante valida un código en su correo (flujos de
 * invitado) o inicia sesión.
 */
@Injectable()
export class GetSigningSessionUseCase {
  constructor(private readonly invitations: SigningInvitationService) {}

  /**
   * Resuelve la sesión de firma de un token.
   *
   * @param token - Token de la invitación, tal como llegó en la ruta.
   * @param now - Instante de referencia; por omisión, el actual.
   * @returns La sesión: completa si está `ACTIVE`, sólo el estado si no.
   *
   * @throws {NotFoundException} Si el token no tiene forma de token, no existe o no es de un
   *   firmante. Un solo mensaje para todos los casos: no confirma cuál falla.
   *
   * @example
   * ```ts
   * const session = await getSigningSession.execute('q3Vb…');
   * // { status: 'ACTIVE', document: { id, name }, signer: {…}, signature: {…}, positions: [], expiresAt }
   * ```
   */
  async execute(
    token: string,
    now: Date = new Date(),
  ): Promise<SigningSession> {
    const invitation = await this.invitations.findByToken(token);
    const document = invitation?.document;
    const collaborator = invitation?.collaborator;

    if (
      !invitation ||
      !document ||
      !collaborator ||
      collaborator.colaboratorType !== COLABORATOR_TYPE_ENUM.SIGNER ||
      !collaborator.signatureType
    ) {
      throw new NotFoundException('Esta invitación no es válida.');
    }

    const status = resolveSigningSessionStatus(
      invitation,
      document,
      collaborator,
      now,
    );
    if (status !== SIGNING_SESSION_STATUS_ENUM.ACTIVE) return { status };

    const summary = summarizeSigningInvitation(document, collaborator);

    return {
      status,
      document: { id: document.id, name: summary.documentName },
      signer: {
        collaboratorId: collaborator.id,
        maskedEmail: summary.maskedEmail,
        accountStatus: collaborator.accountId
          ? (collaborator.account?.user?.lifecycleStatus ??
            USER_LIFECYCLE_STATUS_ENUM.ACTIVE)
          : null,
        guestSigningAllowed: summary.guestSigningAllowed,
      },
      signature: {
        type: collaborator.signatureType,
        requiresEmailVerification: true,
        requiresIdentityValidation:
          collaborator.signatureType === SIGNATURE_TYPE_ENUM.BIOMETRIC,
      },
      positions: signerPositions(collaborator),
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }
}

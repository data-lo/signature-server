import { Injectable } from '@nestjs/common';

import { summarizeSigningInvitation } from 'src/document/applications/get-public-signing-invitation.use-case';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';

import { SIGNING_INVITATION_STATUS_ENUM } from '../enums/signing-invitation-status.enum';
import { isPublicSigningAllowed } from 'src/signing-invitation/public-signing-eligibility';
import { PublicSigningInvitationResolver } from '../services/public-signing-invitation-resolver.service';

/**
 * Contexto mínimo de una invitación: lo necesario para que la pantalla decida qué mostrar antes
 * de validar el código. No incluye el id del documento ni del colaborador, posiciones ni el PDF:
 * eso sale de la sesión (`GET /public/signing-sessions/current`).
 */
export interface SigningInvitationContext {
  status: SIGNING_INVITATION_STATUS_ENUM;
  /** Sólo con `ACTIVE`. */
  document?: { name: string };
  /** Sólo con `ACTIVE`. */
  signer?: {
    /** Correo invitado, enmascarado (`a***@empresa.com`). */
    maskedEmail: string;
    /** Ciclo de vida del usuario de la cuenta vinculada; `null` si no tiene cuenta. */
    accountStatus: USER_LIFECYCLE_STATUS_ENUM | null;
    /** Puede firmar desde la invitación, sin iniciar sesión (ver `isPublicSigningAllowed`). */
    publicSigningAllowed: boolean;
  };
  /** Sólo con `ACTIVE`. */
  signature?: {
    type: SIGNATURE_TYPE_ENUM;
    /** Todo firmante acredita su correo con un código antes de ver el documento. */
    requiresEmailVerification: boolean;
    /** Verificación de identidad en Didit: biométrica siempre, y la simple del usuario provisional. */
    requiresIdentityValidation: boolean;
  };
  /** Sólo con `ACTIVE`: vencimiento del enlace (ISO 8601). */
  expiresAt?: string;
}

/**
 * `GET /public/signing-invitations/:token`: valida el token de `/sign/:token` y devuelve el
 * contexto mínimo, sin exponer el PDF.
 *
 * Todo sale del backend: el documento, el firmante, su correo (enmascarado), su cuenta y el tipo
 * de firma. Una invitación vencida, revocada, de un documento firmado, cancelado o no disponible
 * responde sólo su estado, sin nombre del documento ni datos del firmante.
 */
@Injectable()
export class GetSigningInvitationUseCase {
  constructor(private readonly resolver: PublicSigningInvitationResolver) {}

  /**
   * Resuelve el contexto mínimo de un token.
   *
   * @param token - Token de la invitación.
   * @param now - Instante de referencia; por omisión, el actual.
   * @returns El contexto: completo si está `ACTIVE`, sólo el estado si no.
   *
   * @throws {NotFoundException} Si el token no existe, no tiene forma de token o no es de un
   *   firmante (mensaje genérico).
   *
   * @example
   * ```ts
   * const context = await getSigningInvitation.execute('q3Vb…');
   * // { status: 'ACTIVE', document: { name }, signer: {…}, signature: {…}, expiresAt }
   * ```
   */
  async execute(
    token: string,
    now: Date = new Date(),
  ): Promise<SigningInvitationContext> {
    const { invitation, document, collaborator, status } =
      await this.resolver.resolve(token, now);
    if (status !== SIGNING_INVITATION_STATUS_ENUM.ACTIVE) return { status };

    const summary = summarizeSigningInvitation(document, collaborator);
    const accountStatus = collaborator.accountId
      ? (collaborator.account?.user?.lifecycleStatus ??
        USER_LIFECYCLE_STATUS_ENUM.ACTIVE)
      : null;
    const type = collaborator.signatureType!;

    return {
      status,
      document: { name: summary.documentName },
      signer: {
        maskedEmail: summary.maskedEmail,
        accountStatus,
        publicSigningAllowed: isPublicSigningAllowed(collaborator),
      },
      signature: {
        type,
        requiresEmailVerification: true,
        requiresIdentityValidation:
          type === SIGNATURE_TYPE_ENUM.BIOMETRIC ||
          (type === SIGNATURE_TYPE_ENUM.SIMPLE &&
            accountStatus === USER_LIFECYCLE_STATUS_ENUM.PROVISIONED),
      },
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }
}

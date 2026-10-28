import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';

import { AuditService } from 'src/audit/audit.service';
import {
  AUDIT_AUTH_MECHANISM_ENUM,
  AuditAction,
  AuditActorContext,
} from 'src/audit/schema/audit-document';
import { EmailService } from 'src/common/email/email.service';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from 'src/document/enum/guest-signing-access-purpose.enum';
import { VERIFICATION_EVENT_ENUM } from 'src/document/enum/verification-event.enum';
import {
  SigningAccessChannel,
  SigningRequestMetadata,
} from 'src/document/interfaces/signing-actor.interface';
import { GuestSigningAccessService } from 'src/document/services/guest-signing-access.service';
import { collaboratorEmail } from 'src/document/utils/collaborator-display.util';
import { maskEmail } from 'src/document/utils/mask-email.util';
import { VerificationCodeService } from 'src/document/verification-code.service';
import { isPublicSigningAllowed } from 'src/signing-invitation/public-signing-eligibility';
import { SigningInvitationDeliveryService } from 'src/signing-invitation/signing-invitation-delivery.service';
import { SigningLaunchService } from 'src/signing-invitation/signing-launch.service';
import {
  OTP_SEND_COOLDOWN,
  OTP_SEND_HOURLY,
  OTP_VERIFY_FAILURES,
  SigningRateLimitException,
  SigningRateLimitService,
} from 'src/signing-invitation/signing-rate-limit.service';

import { SIGNING_INVITATION_STATUS_ENUM } from '../enums/signing-invitation-status.enum';
import { PUBLIC_SIGNING_SESSION_TTL_SECONDS } from '../public-signing-session.cookie';
import {
  INVALID_INVITATION_MESSAGE,
  PublicSigningInvitationResolver,
  ResolvedSigningInvitation,
} from '../services/public-signing-invitation-resolver.service';
import { PublicSigningSessionTokenService } from '../services/public-signing-session-token.service';
import { SigningInvitationAccessTokenService } from '../services/signing-invitation-access-token.service';
import {
  SigningInvitationContext,
  toSigningInvitationContext,
} from './get-signing-invitation.use-case';

/** Respuesta única de la renovación: no dice si el enlace existía, venció o se renovó. */
export const RENEW_INVITATION_MESSAGE =
  'Si tu invitación puede renovarse, te enviamos un enlace nuevo a tu correo.';

/** Resultado de canjear un token: el contexto y, si se puede seguir, el acceso para la cookie. */
export interface OpenedInvitationAccess {
  context: SigningInvitationContext;
  /** Sólo si la invitación está activa y admite la firma pública. Va en cookie, nunca en el cuerpo. */
  access: { token: string; expiresAt: Date } | null;
}

/** Resultado del envío del código. */
export interface InvitationCodeSent {
  maskedEmail: string;
  emailDelivered: boolean;
  /** Segundos que faltan para poder pedir otro. */
  resendAfterSeconds: number;
}

/** Sesión pública recién abierta. El token va en la cookie, nunca en el cuerpo. */
export interface OpenedPublicSigningSession {
  token: string;
  expiresAt: Date;
}

/** Mecanismo de auditoría de cada canal antes de la sesión. */
const CHANNEL_MECHANISM: Record<
  SigningAccessChannel,
  AUDIT_AUTH_MECHANISM_ENUM
> = {
  EMAIL: AUDIT_AUTH_MECHANISM_ENUM.INVITATION_TOKEN,
  THIRD_PARTY_PORTAL: AUDIT_AUTH_MECHANISM_ENUM.LAUNCH_TOKEN,
};

/**
 * Lo que pasa antes de la sesión pública de firma, igual para los dos orígenes:
 *
 * 1. **Canje del token de la URL** — el de la invitación del correo (`/sign/:token`, reutilizable
 *    mientras viva) o el de lanzamiento del portal del tercero (`/sign/launch/:token`, minutos y un
 *    solo uso). Los dos terminan en lo mismo: el contexto y una cookie de acceso a la invitación.
 * 2. **Código al correo** guardado de la invitación, pedido y validado con esa cookie. Validarlo
 *    abre la sesión pública (otra cookie), la misma para los dos orígenes.
 *
 * La única diferencia entre correo y portal es cómo se emite y canjea el token inicial. Ninguna
 * operación recibe ids ni correos del cliente; ninguna registra tokens ni códigos.
 */
@Injectable()
export class SigningInvitationAccessUseCases {
  private readonly logger = new Logger(SigningInvitationAccessUseCases.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly resolver: PublicSigningInvitationResolver,
    private readonly verificationCodeService: VerificationCodeService,
    private readonly accesses: GuestSigningAccessService,
    private readonly sessionTokens: PublicSigningSessionTokenService,
    private readonly accessTokens: SigningInvitationAccessTokenService,
    private readonly launches: SigningLaunchService,
    private readonly limits: SigningRateLimitService,
    private readonly delivery: SigningInvitationDeliveryService,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Canjea el token de la invitación del correo (`/sign/:token`). No lo consume: el enlace sirve
   * mientras la invitación viva.
   *
   * @param token - Token de la invitación.
   * @returns El contexto y, si se puede seguir, el acceso para la cookie.
   *
   * @throws {NotFoundException} Si el token no existe o no es de un firmante (mensaje genérico).
   *
   * @example
   * ```ts
   * const { context, access } = await invitationAccess.openWithInvitationToken(token);
   * ```
   */
  async openWithInvitationToken(
    token: string,
  ): Promise<OpenedInvitationAccess> {
    return this.open(await this.resolver.resolve(token), 'EMAIL');
  }

  /**
   * Canjea un token de lanzamiento del portal del tercero (`/sign/launch/:token`): lo consume (un
   * solo uso) y resuelve la invitación del firmante para el que se pidió.
   *
   * @param token - Token de lanzamiento (`sla_…`).
   * @returns El contexto y, si se puede seguir, el acceso para la cookie.
   *
   * @throws {NotFoundException} Si el token no existe, venció o ya se usó (mensaje genérico).
   *
   * @example
   * ```ts
   * const { context, access } = await invitationAccess.openWithLaunchToken('sla_…');
   * ```
   */
  async openWithLaunchToken(token: string): Promise<OpenedInvitationAccess> {
    const launch = await this.launches.redeem(token);
    if (!launch) throw new NotFoundException(INVALID_INVITATION_MESSAGE);
    return this.open(
      await this.resolver.resolveById(launch.invitationId),
      'THIRD_PARTY_PORTAL',
    );
  }

  /**
   * Envía un código de 6 dígitos al correo guardado del firmante de la invitación.
   *
   * @param resolved - Invitación de la cookie de acceso.
   * @param channel - Por dónde llegó el firmante.
   * @param metadata - IP y user-agent.
   * @returns Correo enmascarado, si el correo salió y cuánto esperar para pedir otro.
   *
   * @throws {NotFoundException} Si la invitación ya no está activa o no admite la firma pública.
   * @throws {SigningRateLimitException} (429) Si se pidieron demasiados códigos.
   *
   * @example
   * ```ts
   * await invitationAccess.requestCode(resolved, 'EMAIL', { ipAddress, userAgent });
   * ```
   */
  async requestCode(
    resolved: ResolvedSigningInvitation,
    channel: SigningAccessChannel,
    metadata: SigningRequestMetadata,
  ): Promise<InvitationCodeSent> {
    const { invitation, document, collaborator } =
      this.resolver.assertActive(resolved);
    await this.limits.consume(`inv:${invitation.id}`, [
      OTP_SEND_COOLDOWN,
      OTP_SEND_HOURLY,
    ]);

    const email = collaboratorEmail(collaborator);
    const verificationCode = await this.verificationCodeService.issue(
      document.id,
      collaborator.id,
      VERIFICATION_EVENT_ENUM.PUBLIC_SIGNING_ACCESS,
      metadata.ipAddress ?? '0.0.0.0',
    );

    let emailDelivered = true;
    try {
      await this.emailService.sendVerificationCodeNotification(
        email,
        document.fileName,
        verificationCode.code,
      );
    } catch (error) {
      emailDelivered = false;
      this.logger.warn(
        `No se pudo enviar el código de la invitación ${invitation.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.audit(
      resolved,
      channel,
      AuditAction.SIGNING_INVITATION_OTP_SENT,
      metadata,
      emailDelivered,
    );

    return {
      maskedEmail: maskEmail(email),
      emailDelivered,
      resendAfterSeconds: OTP_SEND_COOLDOWN.windowSeconds,
    };
  }

  /**
   * Valida el código y abre la sesión pública: consume el código y emite el acceso en la misma
   * transacción, y firma el token que irá en la cookie de la sesión.
   *
   * @param resolved - Invitación de la cookie de acceso.
   * @param channel - Por dónde llegó el firmante (queda en la sesión y en la auditoría).
   * @param code - Código de 6 dígitos.
   * @param metadata - IP y user-agent.
   * @returns El token de la sesión (para la cookie) y su vencimiento.
   *
   * @throws {NotFoundException} Si la invitación ya no está activa o no admite la firma pública.
   * @throws {SigningRateLimitException} (429) Si ya hubo demasiados códigos equivocados.
   * @throws {BadRequestException} Si no hay código pendiente, venció o no coincide.
   * @throws {ConflictException} Si otra validación abrió la sesión al mismo tiempo.
   *
   * @example
   * ```ts
   * const { token } = await invitationAccess.verifyCode(resolved, 'THIRD_PARTY_PORTAL', '123456', metadata);
   * ```
   */
  async verifyCode(
    resolved: ResolvedSigningInvitation,
    channel: SigningAccessChannel,
    code: string,
    metadata: SigningRequestMetadata,
  ): Promise<OpenedPublicSigningSession> {
    const { invitation, document, collaborator } =
      this.resolver.assertActive(resolved);
    const subject = `inv:${invitation.id}`;
    await this.limits.assertAvailable(subject, OTP_VERIFY_FAILURES);

    let access;
    try {
      access = await this.dataSource.transaction(async (manager) => {
        await this.verificationCodeService.verifyAndConsume(
          document.id,
          collaborator.id,
          code,
          VERIFICATION_EVENT_ENUM.PUBLIC_SIGNING_ACCESS,
          manager,
        );

        return this.accesses.issue(manager, {
          documentId: document.id,
          collaboratorId: collaborator.id,
          email: collaboratorEmail(collaborator),
          purpose: GUEST_SIGNING_ACCESS_PURPOSE_ENUM.PUBLIC_SIGNING_SESSION,
          ipAddress: metadata.ipAddress,
          ttlSeconds: PUBLIC_SIGNING_SESSION_TTL_SECONDS,
        });
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        await this.limits.record(subject, OTP_VERIFY_FAILURES);
        this.audit(
          resolved,
          channel,
          AuditAction.SIGNING_INVITATION_OTP_VERIFIED,
          metadata,
          false,
        );
      }
      if (
        error instanceof QueryFailedError &&
        (error as QueryFailedError & { code?: string }).code === '23505'
      ) {
        throw new ConflictException(
          'Ya se está validando otro código para esta invitación. Inténtalo de nuevo.',
        );
      }
      throw error;
    }

    await this.limits.reset(subject, OTP_VERIFY_FAILURES);
    this.audit(
      resolved,
      channel,
      AuditAction.SIGNING_INVITATION_OTP_VERIFIED,
      metadata,
      true,
    );

    return this.sessionTokens.issue(access, invitation.id, channel);
  }

  /**
   * Renueva un enlace vencido: si el documento sigue esperando la firma de este firmante, le envía
   * una invitación nueva a su correo. La respuesta es siempre la misma, se haya renovado o no, y el
   * enlace nuevo nunca se devuelve: sólo llega al correo guardado.
   *
   * @param token - Token del enlace vencido.
   * @param metadata - IP y user-agent.
   * @returns El mensaje genérico.
   *
   * @throws Nada que dependa del token (los fallos se registran y la respuesta no cambia).
   *
   * @example
   * ```ts
   * await invitationAccess.renew(expiredToken, metadata);
   * ```
   */
  async renew(
    token: string,
    metadata: SigningRequestMetadata,
  ): Promise<{ message: string }> {
    let resolved: ResolvedSigningInvitation;
    try {
      resolved = await this.resolver.resolve(token);
    } catch (error) {
      if (error instanceof NotFoundException) {
        return { message: RENEW_INVITATION_MESSAGE };
      }
      throw error;
    }

    const { document, collaborator, status } = resolved;
    const renewable =
      status === SIGNING_INVITATION_STATUS_ENUM.EXPIRED &&
      document.status === DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE &&
      collaborator.status === COLLABORATOR_STATUS_ENUM.PENDING &&
      isPublicSigningAllowed(collaborator);
    if (!renewable) return { message: RENEW_INVITATION_MESSAGE };

    try {
      await this.delivery.deliver({
        document,
        collaborator,
        auditActor: this.auditActor(resolved, 'EMAIL', metadata),
        ipAddress: metadata.ipAddress,
      });
    } catch (error) {
      // El límite también se calla: un 429 confirmaría que el enlace existe y venció.
      if (!(error instanceof SigningRateLimitException)) {
        this.logger.error(
          `No se pudo renovar la invitación ${resolved.invitation.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { message: RENEW_INVITATION_MESSAGE };
  }

  /** Contexto de la invitación y, si se puede seguir, el acceso para la cookie. */
  private open(
    resolved: ResolvedSigningInvitation,
    channel: SigningAccessChannel,
  ): OpenedInvitationAccess {
    const canContinue =
      resolved.status === SIGNING_INVITATION_STATUS_ENUM.ACTIVE &&
      isPublicSigningAllowed(resolved.collaborator);
    return {
      context: toSigningInvitationContext(resolved),
      access: canContinue
        ? this.accessTokens.issue({
            invitationId: resolved.invitation.id,
            channel,
          })
        : null,
    };
  }

  private auditActor(
    resolved: ResolvedSigningInvitation,
    channel: SigningAccessChannel,
    metadata: SigningRequestMetadata,
  ): AuditActorContext {
    return {
      type: 'PUBLIC_INVITATION',
      authMechanism: CHANNEL_MECHANISM[channel],
      invitationId: resolved.invitation.id,
      collaboratorId: resolved.collaborator.id,
      accessChannel: channel,
      ...(metadata.userAgent ? { userAgent: metadata.userAgent } : {}),
    };
  }

  private audit(
    resolved: ResolvedSigningInvitation,
    channel: SigningAccessChannel,
    operation: AuditAction,
    metadata: SigningRequestMetadata,
    succeeded: boolean,
  ): void {
    void this.auditService.create({
      documentId: resolved.document.id,
      operation,
      ipAddress: metadata.ipAddress ?? '0.0.0.0',
      actor: this.auditActor(resolved, channel, metadata),
      result: succeeded ? 'SUCCESS' : 'FAILURE',
    });
  }
}

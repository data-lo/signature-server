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
import { SigningRequestMetadata } from 'src/document/interfaces/signing-actor.interface';
import { GuestSigningAccessService } from 'src/document/services/guest-signing-access.service';
import { collaboratorEmail } from 'src/document/utils/collaborator-display.util';
import { maskEmail } from 'src/document/utils/mask-email.util';
import { VerificationCodeService } from 'src/document/verification-code.service';
import { SigningInvitationDeliveryService } from 'src/signing-invitation/signing-invitation-delivery.service';
import {
  OTP_SEND_COOLDOWN,
  OTP_SEND_HOURLY,
  OTP_VERIFY_FAILURES,
  SigningRateLimitException,
  SigningRateLimitService,
} from 'src/signing-invitation/signing-rate-limit.service';

import { SIGNING_INVITATION_STATUS_ENUM } from '../enums/signing-invitation-status.enum';
import { isPublicSigningAllowed } from 'src/signing-invitation/public-signing-eligibility';
import { PUBLIC_SIGNING_SESSION_TTL_SECONDS } from '../public-signing-session.cookie';
import {
  PublicSigningInvitationResolver,
  ResolvedSigningInvitation,
} from '../services/public-signing-invitation-resolver.service';
import { PublicSigningSessionTokenService } from '../services/public-signing-session-token.service';

/** Respuesta única de la renovación: no dice si el enlace existía, venció o se renovó. */
export const RENEW_INVITATION_MESSAGE =
  'Si tu invitación puede renovarse, te enviamos un enlace nuevo a tu correo.';

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

/**
 * Lo que se hace con el token de una invitación antes de tener sesión: pedir el código al correo,
 * validarlo (abre la sesión pública) y renovar un enlace vencido.
 *
 * Ninguna operación recibe ids del documento o del colaborador: todo sale del token. Ninguna
 * registra el token ni el código; la auditoría lleva ids, mecanismo (`INVITATION_TOKEN`), IP,
 * user-agent y resultado.
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
    private readonly limits: SigningRateLimitService,
    private readonly delivery: SigningInvitationDeliveryService,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Envía un código de 6 dígitos al correo guardado del firmante.
   *
   * @param token - Token de la invitación.
   * @param metadata - IP y user-agent.
   * @returns Correo enmascarado, si el correo salió y cuánto esperar para pedir otro.
   *
   * @throws {NotFoundException} Si la invitación no está activa o no admite la firma pública
   *   (mensaje genérico).
   * @throws {SigningRateLimitException} (429) Si se pidieron demasiados códigos para la invitación.
   *
   * @example
   * ```ts
   * const { maskedEmail } = await access.requestCode(token, { ipAddress, userAgent });
   * ```
   */
  async requestCode(
    token: string,
    metadata: SigningRequestMetadata,
  ): Promise<InvitationCodeSent> {
    const resolved = await this.resolver.resolveActive(token);
    const { invitation, document, collaborator } = resolved;
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
   * transacción, y firma el token que irá en la cookie.
   *
   * @param token - Token de la invitación.
   * @param code - Código de 6 dígitos.
   * @param metadata - IP y user-agent.
   * @returns El token de la sesión (para la cookie) y su vencimiento.
   *
   * @throws {NotFoundException} Si la invitación no está activa o no admite la firma pública.
   * @throws {SigningRateLimitException} (429) Si ya hubo demasiados códigos equivocados.
   * @throws {BadRequestException} Si no hay código pendiente, venció o no coincide.
   * @throws {ConflictException} Si otra validación abrió la sesión al mismo tiempo.
   *
   * @example
   * ```ts
   * const { token, expiresAt } = await access.verifyCode(invitationToken, '123456', metadata);
   * ```
   */
  async verifyCode(
    token: string,
    code: string,
    metadata: SigningRequestMetadata,
  ): Promise<OpenedPublicSigningSession> {
    const resolved = await this.resolver.resolveActive(token);
    const { invitation, document, collaborator } = resolved;
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
      AuditAction.SIGNING_INVITATION_OTP_VERIFIED,
      metadata,
      true,
    );

    return this.sessionTokens.issue(access, invitation.id);
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
   * await access.renew(expiredToken, metadata);
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
        auditActor: this.auditActor(resolved, metadata),
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

  private auditActor(
    resolved: ResolvedSigningInvitation,
    metadata: SigningRequestMetadata,
  ): AuditActorContext {
    return {
      type: 'PUBLIC_INVITATION',
      authMechanism: AUDIT_AUTH_MECHANISM_ENUM.INVITATION_TOKEN,
      invitationId: resolved.invitation.id,
      collaboratorId: resolved.collaborator.id,
      ...(metadata.userAgent ? { userAgent: metadata.userAgent } : {}),
    };
  }

  private audit(
    resolved: ResolvedSigningInvitation,
    operation: AuditAction,
    metadata: SigningRequestMetadata,
    succeeded: boolean,
  ): void {
    void this.auditService.create({
      documentId: resolved.document.id,
      operation,
      ipAddress: metadata.ipAddress ?? '0.0.0.0',
      actor: this.auditActor(resolved, metadata),
      result: succeeded ? 'SUCCESS' : 'FAILURE',
    });
  }
}

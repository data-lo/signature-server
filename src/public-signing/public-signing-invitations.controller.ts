import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';

import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';
import { ClientIp } from 'src/common/interceptors/request-ip.decorator';

import {
  GetSigningInvitationUseCase,
  toSigningInvitationContext,
} from './applications/get-signing-invitation.use-case';
import { SigningInvitationAccessUseCases } from './applications/signing-invitation-access.use-cases';
import { CurrentInvitationAccess } from './decorators/current-invitation-access.decorator';
import {
  ApiGetCurrentSigningInvitation,
  ApiGetSigningInvitation,
  ApiOpenSigningInvitation,
  ApiRenewSigningInvitation,
  ApiRequestSigningInvitationCode,
  ApiVerifySigningInvitationCode,
} from './docs/api-public-signing.docs';
import { VerifySigningInvitationCodeDto } from './dto/public-signing.dto';
import { SigningInvitationAccessGuard } from './guards/signing-invitation-access.guard';
import { SigningInvitationAccessContext } from './interfaces/signing-invitation-access-context.interface';
import {
  PUBLIC_SIGNING_INVITATION_COOKIE,
  PUBLIC_SIGNING_SESSION_COOKIE,
  publicSigningSessionCookieOptions,
} from './public-signing-session.cookie';

/**
 * Invitaciones individuales de firma, ANTES de tener sesión.
 *
 * - Por token del correo (`/sign/:token`): consultar el estado, canjearlo (deja la cookie de acceso
 *   a la invitación) y renovar un enlace vencido.
 * - Con la cookie de acceso —venga del correo o del portal del tercero
 *   (`PublicSigningLaunchesController`)—: el contexto, pedir el código y validarlo, que abre la
 *   sesión pública.
 *
 * Audiencia: el colaborador invitado, sin JWT ni API key. No recibe ids del documento, del
 * colaborador, ni el correo: todo sale del token o de la cookie. Cada ruta lleva su throttle por
 * IP además de los límites por invitación de los casos de uso.
 */
@ApiTags('Public signing invitations')
@SkipJwtAuth()
@UseGuards(ThrottlerGuard)
@Controller('public/signing-invitations')
export class PublicSigningInvitationsController {
  constructor(
    private readonly getSigningInvitation: GetSigningInvitationUseCase,
    private readonly invitationAccess: SigningInvitationAccessUseCases,
  ) {}

  @Get('current')
  @UseGuards(SigningInvitationAccessGuard)
  @ApiGetCurrentSigningInvitation()
  current(@CurrentInvitationAccess() access: SigningInvitationAccessContext) {
    return toSigningInvitationContext(access.resolved);
  }

  @Post('current/otp')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SigningInvitationAccessGuard)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @ApiRequestSigningInvitationCode()
  requestCode(
    @CurrentInvitationAccess() access: SigningInvitationAccessContext,
    @ClientIp() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.invitationAccess.requestCode(access.resolved, access.channel, {
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    });
  }

  @Post('current/otp/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SigningInvitationAccessGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiVerifySigningInvitationCode()
  async verifyCode(
    @CurrentInvitationAccess() access: SigningInvitationAccessContext,
    @Body() dto: VerifySigningInvitationCodeDto,
    @ClientIp() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.invitationAccess.verifyCode(
      access.resolved,
      access.channel,
      dto.code,
      { ipAddress: ipAddress ?? null, userAgent: userAgent ?? null },
    );
    response.cookie(
      PUBLIC_SIGNING_SESSION_COOKIE,
      session.token,
      publicSigningSessionCookieOptions(
        session.expiresAt.getTime() - Date.now(),
      ),
    );
    // El acceso a la invitación ya cumplió: lo que sigue es la sesión.
    response.clearCookie(
      PUBLIC_SIGNING_INVITATION_COOKIE,
      publicSigningSessionCookieOptions(0),
    );
    return { expiresAt: session.expiresAt };
  }

  @Get(':token')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiGetSigningInvitation()
  invitation(@Param('token') token: string) {
    return this.getSigningInvitation.execute(token);
  }

  @Post(':token/access')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOpenSigningInvitation()
  async open(
    @Param('token') token: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { context, access } =
      await this.invitationAccess.openWithInvitationToken(token);
    setInvitationAccessCookie(response, access);
    return context;
  }

  @Post(':token/renew')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @ApiRenewSigningInvitation()
  renew(
    @Param('token') token: string,
    @ClientIp() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.invitationAccess.renew(token, {
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    });
  }
}

/**
 * Deja (o quita) la cookie de acceso a la invitación tras canjear un token.
 *
 * @param response - Respuesta de Express.
 * @param access - Acceso emitido, o `null` si la invitación no admite seguir (se borra la cookie
 *   que hubiera de otra invitación).
 * @returns Nada.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * setInvitationAccessCookie(response, access);
 * ```
 */
export function setInvitationAccessCookie(
  response: Response,
  access: { token: string; expiresAt: Date } | null,
): void {
  if (!access) {
    response.clearCookie(
      PUBLIC_SIGNING_INVITATION_COOKIE,
      publicSigningSessionCookieOptions(0),
    );
    return;
  }
  response.cookie(
    PUBLIC_SIGNING_INVITATION_COOKIE,
    access.token,
    publicSigningSessionCookieOptions(access.expiresAt.getTime() - Date.now()),
  );
}

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

import { GetSigningInvitationUseCase } from './applications/get-signing-invitation.use-case';
import { SigningInvitationAccessUseCases } from './applications/signing-invitation-access.use-cases';
import {
  ApiGetSigningInvitation,
  ApiRenewSigningInvitation,
  ApiRequestSigningInvitationCode,
  ApiVerifySigningInvitationCode,
} from './docs/api-public-signing.docs';
import { VerifySigningInvitationCodeDto } from './dto/public-signing.dto';
import {
  PUBLIC_SIGNING_SESSION_COOKIE,
  publicSigningSessionCookieOptions,
} from './public-signing-session.cookie';

/**
 * Invitaciones individuales de firma (`/sign/:token`), ANTES de tener sesión: validar el token,
 * pedir y validar el código del correo, y renovar un enlace vencido.
 *
 * Audiencia: el colaborador invitado, sin JWT ni API key. Su único mecanismo es el token de la
 * ruta; no recibe ids del documento, del colaborador ni el tipo de firma. Cada ruta lleva su
 * throttle por IP además de los límites por invitación de los casos de uso.
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

  @Get(':token')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiGetSigningInvitation()
  invitation(@Param('token') token: string) {
    return this.getSigningInvitation.execute(token);
  }

  @Post(':token/otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @ApiRequestSigningInvitationCode()
  requestCode(
    @Param('token') token: string,
    @ClientIp() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.invitationAccess.requestCode(token, {
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    });
  }

  @Post(':token/otp/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiVerifySigningInvitationCode()
  async verifyCode(
    @Param('token') token: string,
    @Body() dto: VerifySigningInvitationCodeDto,
    @ClientIp() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.invitationAccess.verifyCode(token, dto.code, {
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    });
    response.cookie(
      PUBLIC_SIGNING_SESSION_COOKIE,
      session.token,
      publicSigningSessionCookieOptions(
        session.expiresAt.getTime() - Date.now(),
      ),
    );
    return { expiresAt: session.expiresAt };
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

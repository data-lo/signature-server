import {
  Controller,
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

import { SigningInvitationAccessUseCases } from './applications/signing-invitation-access.use-cases';
import { ApiOpenSigningLaunch } from './docs/api-public-signing.docs';
import { setInvitationAccessCookie } from './public-signing-invitations.controller';

/**
 * Accesos temporales desde el portal del tercero (`/sign/launch/:token`). Lo único que cambia
 * respecto del correo es el token inicial: aquí es de un solo uso y vive minutos. Canjearlo deja la
 * MISMA cookie de acceso a la invitación, y de ahí en adelante el firmante sigue por
 * `/public/signing-invitations/current/...` (código al correo) y la sesión pública.
 *
 * Audiencia: el colaborador invitado, sin JWT ni API key (la API key la usó el backend del tercero
 * para pedir el acceso, no el navegador).
 */
@ApiTags('Public signing invitations')
@SkipJwtAuth()
@UseGuards(ThrottlerGuard)
@Controller('public/signing-launches')
export class PublicSigningLaunchesController {
  constructor(
    private readonly invitationAccess: SigningInvitationAccessUseCases,
  ) {}

  @Post(':token/access')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOpenSigningLaunch()
  async open(
    @Param('token') token: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { context, access } =
      await this.invitationAccess.openWithLaunchToken(token);
    setInvitationAccessCookie(response, access);
    return context;
  }
}

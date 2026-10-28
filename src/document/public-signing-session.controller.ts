import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';

import { GetSigningSessionUseCase } from './applications/get-signing-session.use-case';
import { ApiGetSigningSession } from './docs/api-get-signing-session.docs';

/**
 * Sesión de firma por invitación individual, la que abre la pantalla pública `/sign/:token`. Va
 * aparte de `PublicSigningController` porque no cuelga de un documento: el token es lo único que
 * llega, y el documento lo resuelve el backend.
 */
@ApiTags('Public signing (guest)')
@Controller('public/signing-sessions')
export class PublicSigningSessionController {
  constructor(private readonly getSigningSession: GetSigningSessionUseCase) {}

  @Get(':token')
  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiGetSigningSession()
  session(@Param('token') token: string) {
    return this.getSigningSession.execute(token);
  }
}

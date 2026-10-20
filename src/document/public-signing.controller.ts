import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';

import { GetPublicSigningMethodUseCase } from './applications/get-public-signing-method.use-case';
import { PublicSigningInvitationDto } from './dto/public-signing-invitation.dto';
import { ApiGetPublicSigningMethod } from './docs/api-get-public-signing-method.docs';

/**
 * Lo común a la firma pública de invitados, sea cual sea su tipo. Cada flujo (biometría, Firma
 * Avanzada) tiene su propio controlador para pedir código, canjearlo y firmar; aquí sólo se
 * resuelve cuál de ellos le toca a la invitación.
 */
@ApiTags('Public signing (guest)')
@Controller('public/documents/:documentId')
export class PublicSigningController {
  constructor(
    private readonly getPublicSigningMethod: GetPublicSigningMethodUseCase,
  ) {}

  @Get('signing-method')
  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiGetPublicSigningMethod()
  signingMethod(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Query() query: PublicSigningInvitationDto,
  ) {
    return this.getPublicSigningMethod.execute(
      documentId,
      query.collaboratorId,
      query.email,
    );
  }
}

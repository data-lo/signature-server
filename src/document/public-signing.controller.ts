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

import { GetPublicSigningInvitationUseCase } from './applications/get-public-signing-invitation.use-case';
import { PublicSigningInvitationDto } from './dto/public-signing-invitation.dto';
import { ApiGetPublicSigningInvitation } from './docs/api-get-public-signing-invitation.docs';

/**
 * Lo común a la firma pública de invitados, sea cual sea su tipo. Cada flujo (biometría, Firma
 * Avanzada) tiene su propio controlador para pedir código, canjearlo y firmar; aquí sólo se
 * valida la invitación y se resuelve cuál de ellos le toca.
 */
@ApiTags('Public signing (guest)')
@Controller('public/documents/:documentId')
export class PublicSigningController {
  constructor(
    private readonly getPublicSigningInvitation: GetPublicSigningInvitationUseCase,
  ) {}

  @Get('invitation')
  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiGetPublicSigningInvitation()
  invitation(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Query() query: PublicSigningInvitationDto,
  ) {
    return this.getPublicSigningInvitation.execute(
      documentId,
      query.collaboratorId,
    );
  }
}

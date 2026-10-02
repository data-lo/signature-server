import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';
import { ClientIp } from 'src/common/interceptors/request-ip.decorator';

import { StartBiometricSignatureDto } from './dto/start-biometric-signature.dto';
import {
  GuestInvitationDto,
  VerifyGuestAccessCodeDto,
} from './dto/guest-invitation.dto';
import { StartGuestBiometricSignatureUseCase } from './applications/start-guest-biometric-signature.use-case';
import { GetBiometricSignatureStatusUseCase } from './applications/get-biometric-signature-status.use-case';
import { GuestBiometricAccessUseCases } from './applications/guest-access.use-cases';
import {
  CurrentGuestAccess,
  GuestAccessGuard,
} from './guest/guest-access.guard';
import { GuestAccessClaims } from './guest/guest-access-token.service';
import {
  ApiCheckGuestInvitation,
  ApiGetGuestBiometricSession,
  ApiGetGuestSigningDocument,
  ApiRequestGuestAccessCode,
  ApiStartGuestBiometricSession,
  ApiVerifyGuestAccessCode,
} from './docs/api-public-biometric-signature.docs';

/**
 * Firma biométrica del invitado SIN cuenta. Todas las rutas van sin sesión (`@SkipJwtAuth()`):
 *
 * - `invitation`, `access-code` y `access-code/verify` identifican la invitación y canjean el
 *   código del correo por un token. Llevan throttling: el código es de 6 dígitos.
 * - `document` y `session` exigen ese token (`GuestAccessGuard`, cabecera
 *   `X-Biometric-Guest-Token`), atado a este documento, este colaborador y este correo.
 */
@ApiTags('Biometric signature (guest)')
@Controller('public/documents/:documentId/biometric-signature')
export class PublicBiometricSignatureController {
  constructor(
    private readonly guestAccess: GuestBiometricAccessUseCases,
    private readonly startGuestSignature: StartGuestBiometricSignatureUseCase,
    private readonly getStatus: GetBiometricSignatureStatusUseCase,
  ) {}

  @Get('invitation')
  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiCheckGuestInvitation()
  checkInvitation(
    @Param('documentId') documentId: string,
    @Query() query: GuestInvitationDto,
  ) {
    return this.guestAccess.checkInvitation(
      documentId,
      query.collaboratorId,
      query.email,
    );
  }

  @Post('access-code')
  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiRequestGuestAccessCode()
  requestAccessCode(
    @Param('documentId') documentId: string,
    @Body() dto: GuestInvitationDto,
    @ClientIp() ipAddress: string,
  ) {
    return this.guestAccess.requestCode(
      documentId,
      dto.collaboratorId,
      dto.email,
      ipAddress,
    );
  }

  @Post('access-code/verify')
  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiVerifyGuestAccessCode()
  verifyAccessCode(
    @Param('documentId') documentId: string,
    @Body() dto: VerifyGuestAccessCodeDto,
  ) {
    return this.guestAccess.verifyCode(
      documentId,
      dto.collaboratorId,
      dto.email,
      dto.code,
    );
  }

  @Get('document')
  @SkipJwtAuth()
  @UseGuards(GuestAccessGuard)
  @ApiGetGuestSigningDocument()
  getDocument(
    @Param('documentId') documentId: string,
    @CurrentGuestAccess() access: GuestAccessClaims,
  ) {
    return this.guestAccess.getDocument(documentId, access);
  }

  @Post('session')
  @SkipJwtAuth()
  @UseGuards(GuestAccessGuard)
  @ApiStartGuestBiometricSession()
  start(
    @Param('documentId') documentId: string,
    @CurrentGuestAccess() access: GuestAccessClaims,
    @Body() dto: StartBiometricSignatureDto,
    @ClientIp() ipAddress: string,
  ) {
    return this.startGuestSignature.execute(
      documentId,
      access,
      dto,
      ipAddress ?? null,
    );
  }

  @Get('session')
  @SkipJwtAuth()
  @UseGuards(GuestAccessGuard)
  @ApiGetGuestBiometricSession()
  status(
    @Param('documentId') documentId: string,
    @CurrentGuestAccess() access: GuestAccessClaims,
  ) {
    return this.getStatus.forGuest(documentId, access);
  }
}

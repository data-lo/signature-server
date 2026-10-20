import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';
import { ClientIp } from 'src/common/interceptors/request-ip.decorator';
import { MAX_UPLOAD_SAFETY_NET_BYTES } from 'src/common/constants/file-upload.constants';
import { SignDocumentUseCase } from 'src/document/applications/sign-document.use-case';

import {
  GuestAdvancedInvitationDto,
  SignGuestAdvancedDocumentDto,
  VerifyGuestAdvancedAccessCodeDto,
} from './dto/guest-advanced-invitation.dto';
import { GuestAdvancedSignatureAccessUseCases } from './applications/guest-advanced-signature-access.use-cases';
import {
  CurrentGuestSigningAccess,
  GuestSigningAccessGuard,
} from './guest/guest-signing-access.guard';
import { GuestSigningTokenClaims } from './guest/guest-signing-token.service';
import {
  ApiCheckGuestAdvancedInvitation,
  ApiGetGuestAdvancedSigningDocument,
  ApiRequestGuestAdvancedAccessCode,
  ApiSignGuestAdvancedDocument,
  ApiVerifyGuestAdvancedAccessCode,
} from './docs/api-public-guest-advanced-signature.docs';

/**
 * Firma Avanzada (FIEL) del invitado SIN cuenta. Todas las rutas van sin sesión (`@SkipJwtAuth()`):
 *
 * - `invitation`, `access-code` y `access-code/verify` identifican la invitación y canjean el
 *   código del correo por un acceso temporal. Llevan throttling: el código es de 6 dígitos.
 * - `document` y `sign` exigen ese acceso (`GuestSigningAccessGuard`, cabecera
 *   `X-Guest-Signing-Token`), activo y atado a este documento y este colaborador.
 *
 * El invitado CON cuenta no pasa por aquí: inicia sesión desde el mismo enlace, se vincula con
 * `PATCH /document/:id/link-collaborator` y firma por el flujo privado de siempre.
 */
@ApiTags('Advanced signature (guest)')
@Controller('public/documents/:documentId/advanced-signature')
export class PublicGuestAdvancedSignatureController {
  constructor(
    private readonly guestAccess: GuestAdvancedSignatureAccessUseCases,
    private readonly signDocument: SignDocumentUseCase,
  ) {}

  @Get('invitation')
  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiCheckGuestAdvancedInvitation()
  checkInvitation(
    @Param('documentId') documentId: string,
    @Query() query: GuestAdvancedInvitationDto,
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
  @ApiRequestGuestAdvancedAccessCode()
  requestAccessCode(
    @Param('documentId') documentId: string,
    @Body() dto: GuestAdvancedInvitationDto,
    @ClientIp() ipAddress: string,
  ) {
    return this.guestAccess.requestCode(
      documentId,
      dto.collaboratorId,
      dto.email,
      ipAddress ?? null,
    );
  }

  @Post('access-code/verify')
  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiVerifyGuestAdvancedAccessCode()
  verifyAccessCode(
    @Param('documentId') documentId: string,
    @Body() dto: VerifyGuestAdvancedAccessCodeDto,
    @ClientIp() ipAddress: string,
  ) {
    return this.guestAccess.verifyCode(
      documentId,
      dto.collaboratorId,
      dto.email,
      dto.code,
      ipAddress ?? null,
    );
  }

  @Get('document')
  @SkipJwtAuth()
  @UseGuards(GuestSigningAccessGuard)
  @ApiGetGuestAdvancedSigningDocument()
  getDocument(
    @Param('documentId') documentId: string,
    @CurrentGuestSigningAccess() access: GuestSigningTokenClaims,
  ) {
    return this.guestAccess.getDocument(documentId, access);
  }

  @Post('sign')
  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard, GuestSigningAccessGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiSignGuestAdvancedDocument()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'key', maxCount: 1 },
        { name: 'cer', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_UPLOAD_SAFETY_NET_BYTES } },
    ),
  )
  sign(
    @Param('documentId') documentId: string,
    @CurrentGuestSigningAccess() access: GuestSigningTokenClaims,
    @Body() dto: SignGuestAdvancedDocumentDto,
    @UploadedFiles()
    files: { key?: Express.Multer.File[]; cer?: Express.Multer.File[] },
    @ClientIp() ipAddress: string,
  ) {
    return this.signDocument.executeGuestAdvanced({
      accessId: access.accessId,
      documentId,
      collaboratorId: access.collaboratorId,
      documentHash: dto.documentHash,
      advancedSignatureInput: {
        password: dto.password,
        keyFile: files?.key?.[0],
        cerFile: files?.cer?.[0],
      },
      geolocation: dto.geolocation,
      ipAddress: ipAddress ?? null,
    });
  }
}

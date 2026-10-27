import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';
import { StartBiometricSignatureDto } from 'src/biometric-signature/dto/start-biometric-signature.dto';
import { MAX_UPLOAD_SAFETY_NET_BYTES } from 'src/common/constants/file-upload.constants';
import { ClientIp } from 'src/common/interceptors/request-ip.decorator';
import { SignGuestAdvancedDocumentDto } from 'src/guest-advanced-signature/dto/guest-advanced-invitation.dto';
import { CreateDiditSessionDto } from 'src/identity-verification/dto/create-didit-session.dto';

import { PublicSigningSessionUseCases } from './applications/public-signing-session.use-cases';
import { CurrentSigningSession } from './decorators/current-signing-session.decorator';
import {
  ApiGetCurrentSigningDocument,
  ApiGetCurrentSigningSession,
  ApiSignPublicAdvanced,
  ApiSignPublicBiometric,
  ApiSignPublicSimple,
  ApiVerifyPublicSignerIdentity,
} from './docs/api-public-signing.docs';
import { PublicSigningSessionGuard } from './guards/public-signing-session.guard';
import { PublicSigningSessionContext } from './interfaces/public-signing-session-context.interface';

/**
 * Sesión pública de firma, DESPUÉS de validar el código: contexto completo, PDF, verificación de
 * identidad y firma por tipo.
 *
 * Audiencia: el colaborador invitado. Su único mecanismo es la cookie `HttpOnly` de la sesión
 * (`PublicSigningSessionGuard`); estas rutas no reciben el token de la invitación, ni JWT, ni API
 * key, ni ids del documento o del colaborador. El tipo de firma sale de la invitación: cada ruta
 * de firma rechaza a un firmante de otro tipo.
 */
@ApiTags('Public signing sessions')
@SkipJwtAuth()
@UseGuards(ThrottlerGuard, PublicSigningSessionGuard)
@Controller('public/signing-sessions/current')
export class PublicSigningSessionsController {
  constructor(private readonly sessions: PublicSigningSessionUseCases) {}

  @Get()
  @ApiGetCurrentSigningSession()
  current(@CurrentSigningSession() session: PublicSigningSessionContext) {
    return this.sessions.current(session);
  }

  @Get('document')
  @ApiGetCurrentSigningDocument()
  document(@CurrentSigningSession() session: PublicSigningSessionContext) {
    return this.sessions.document(session);
  }

  @Post('simple/verify-identity')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiVerifyPublicSignerIdentity()
  verifyIdentity(
    @CurrentSigningSession() session: PublicSigningSessionContext,
    @Body() dto: CreateDiditSessionDto,
  ) {
    return this.sessions.verifyIdentity(session, dto);
  }

  @Post('simple/sign')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiSignPublicSimple()
  @UseInterceptors(
    FileFieldsInterceptor([{ name: 'signatureImage', maxCount: 1 }], {
      limits: { fileSize: MAX_UPLOAD_SAFETY_NET_BYTES },
    }),
  )
  signSimple(
    @CurrentSigningSession() session: PublicSigningSessionContext,
    @Body() dto: SignGuestAdvancedDocumentDto,
    @UploadedFiles() files: { signatureImage?: Express.Multer.File[] },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @ClientIp() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.sessions.signSimple(
      session,
      {
        documentHash: dto.documentHash,
        geolocation: dto.geolocation,
        idempotencyKey,
        metadata: {
          ipAddress: ipAddress ?? null,
          userAgent: userAgent ?? null,
        },
      },
      files?.signatureImage?.[0],
    );
  }

  @Post('advanced/sign')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiSignPublicAdvanced()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'key', maxCount: 1 },
        { name: 'cer', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_UPLOAD_SAFETY_NET_BYTES } },
    ),
  )
  signAdvanced(
    @CurrentSigningSession() session: PublicSigningSessionContext,
    @Body() dto: SignGuestAdvancedDocumentDto,
    @UploadedFiles()
    files: { key?: Express.Multer.File[]; cer?: Express.Multer.File[] },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @ClientIp() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.sessions.signAdvanced(
      session,
      {
        documentHash: dto.documentHash,
        geolocation: dto.geolocation,
        idempotencyKey,
        metadata: {
          ipAddress: ipAddress ?? null,
          userAgent: userAgent ?? null,
        },
      },
      {
        keyFile: files?.key?.[0],
        cerFile: files?.cer?.[0],
        password: dto.password,
      },
    );
  }

  @Post('biometric/sign')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiSignPublicBiometric()
  signBiometric(
    @CurrentSigningSession() session: PublicSigningSessionContext,
    @Body() dto: StartBiometricSignatureDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @ClientIp() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.sessions.signBiometric(session, dto, idempotencyKey, {
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    });
  }
}

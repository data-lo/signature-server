import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';

import { ApiVerifyPublicDocument } from '../docs/api-verify-public-document.docs';
import { PublicVerificationUploadFilter } from './public-verification-upload.filter';
import { MAX_VERIFICATION_XML_BYTES } from './public-verification.types';
import {
  VerificationUploadStorage,
  type VerificationUploadedFile,
} from './verification-upload.storage';
import {
  VerifyPublicDocumentUseCase,
  type PublicVerificationResult,
} from './verify-public-document.use-case';

/** Verificaciones públicas permitidas por IP y por minuto. */
export const PUBLIC_VERIFICATION_RATE_LIMIT = { limit: 10, ttl: 60_000 };

/**
 * Consulta pública de verificación por archivo (`/verify` en signature-app).
 *
 * Controlador propio, aparte de `DocumentController`: la ruta no comparte nada con el resto
 * (ni sesión, ni cuenta, ni permisos) y así se puede montar y probar sola.
 */
@Controller('document/public')
export class PublicDocumentVerificationController {
  constructor(
    private readonly verifyPublicDocument: VerifyPublicDocumentUseCase,
  ) {}

  /**
   * Verifica un XML de auditoría o un PDF final por su SHA-256.
   *
   * `VerificationUploadStorage` analiza el archivo mientras llega y lo descarta: aquí sólo llega su
   * análisis. `limits.fileSize` es el tope del tipo más grande (XML); el del PDF lo aplica el
   * analizador. Sin `fields`: el formulario sólo lleva el archivo.
   *
   * @param file - Archivo analizado, o `undefined` si no llegó ninguno.
   * @returns El resultado de la verificación.
   *
   * @example
   * ```bash
   * curl -F file=@auditoria-<id>.xml https://<api>/api/v1/document/public/verify
   * ```
   */
  @Post('verify')
  @SkipJwtAuth()
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: PUBLIC_VERIFICATION_RATE_LIMIT })
  @UseFilters(PublicVerificationUploadFilter)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: new VerificationUploadStorage(),
      limits: {
        fileSize: MAX_VERIFICATION_XML_BYTES,
        files: 1,
        fields: 0,
      },
    }),
  )
  @ApiVerifyPublicDocument()
  verify(
    @UploadedFile() file: VerificationUploadedFile | undefined,
  ): Promise<PublicVerificationResult> {
    return this.verifyPublicDocument.execute(file?.verification);
  }
}

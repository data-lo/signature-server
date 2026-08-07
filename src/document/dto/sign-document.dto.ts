import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * `password` solo es obligatoria cuando el firmante es de tipo FIEL — se valida así en
 * `DocumentService.sign()`, no aquí con `@IsNotEmpty`, porque acá todavía no se sabe el
 * `signatureType` del colaborador (depende de a quién pertenece el token). Los archivos
 * `.key`/`.cer` llegan por separado vía `@UploadedFiles()` (`FileFieldsInterceptor`), no como
 * parte de este DTO — mismo patrón que `EfirmaController` (ya eliminado, ver
 * `EfirmaModule`) usaba para su propio DTO.
 */
export class SignDocumentDto {
  @ApiPropertyOptional({
    description:
      'Contraseña de la llave privada (.key). Requerida únicamente para firma electrónica avanzada (FIEL).',
  })
  @IsOptional()
  @IsString()
  password?: string;
}

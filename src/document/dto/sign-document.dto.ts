import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Evidencia de ubicación declarada por el dispositivo del firmante (`navigator.geolocation`) al
 * momento de firmar. Es un dato reportado por el cliente, no verificado de forma independiente
 * por el servidor — se valida el formato/rango y se almacena como evidencia declarada, igual que
 * `ipAddress`.
 */
export class GeolocationDto {
  @ApiProperty({ example: 19.4326, minimum: -90, maximum: 90 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude: number;

  @ApiProperty({ example: -99.1332, minimum: -180, maximum: 180 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude: number;

  @ApiPropertyOptional({
    example: 12.5,
    minimum: 0,
    description: 'Precisión reportada por el dispositivo, en metros',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracy?: number;
}

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

  /**
   * Opcional: rechazar el permiso de ubicación en el navegador no bloquea la firma (ver
   * historia "Capturar y almacenar la geolocalización al firmar documentos") — cuando no llega,
   * `CollaboratorEntity.geoLoc` queda en null y la evidencia lo refleja como no disponible.
   *
   * Este endpoint siempre recibe multipart/form-data (lo exige `FileFieldsInterceptor`, usado
   * para los archivos `.key`/`.cer` de FIEL) — multer entrega cada campo de texto como string
   * plano, así que `geolocation` llega como JSON serializado, no como objeto. El `@Transform`
   * lo parsea antes de que corran `@ValidateNested`/`@Type`; si no es JSON válido se deja tal
   * cual para que la validación de tipos falle con un 400 claro en vez de reventar aquí.
   */
  @ApiPropertyOptional({
    type: GeolocationDto,
    description:
      'Serializado como JSON string dentro del multipart/form-data (ver @Transform).',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  })
  @ValidateNested()
  @Type(() => GeolocationDto)
  geolocation?: GeolocationDto;
}

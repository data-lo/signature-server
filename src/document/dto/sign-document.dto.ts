import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { plainToInstance, Transform, Type } from 'class-transformer';

/** Devuelve el objeto parseado, o el string original si no es JSON válido (para que falle la validación, no el parseo). */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
import {
  IsDefined,
  IsNotEmptyObject,
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
   * OBLIGATORIA: sin ubicación no se puede firmar. Antes era opcional (rechazar el permiso del
   * navegador dejaba `geoLoc` en null y la firma seguía adelante); el requisito cambió y ahora
   * la ubicación es parte no negociable de la evidencia de firma, así que su ausencia corta el
   * proceso con un 400 en vez de registrar una firma sin ella.
   *
   * La validación vive aquí, en el servidor, y no solo en la UI: el bloqueo del cliente es
   * evitable llamando al endpoint directamente, y esta es evidencia de una firma legalmente
   * vinculante.
   *
   * Este endpoint siempre recibe multipart/form-data (lo exige `FileFieldsInterceptor`, usado
   * para los archivos `.key`/`.cer` de FIEL) — multer entrega cada campo de texto como string
   * plano, así que `geolocation` llega como JSON serializado, no como objeto.
   *
   * El `@Transform` devuelve una INSTANCIA de `GeolocationDto`, no el objeto plano del
   * `JSON.parse`. Es imprescindible: cuando `@Transform` está presente, class-transformer usa su
   * resultado tal cual y `@Type(() => GeolocationDto)` ya no se aplica. Con un objeto plano sin
   * metadatos de clase, `@ValidateNested()` no validaba nada (se aceptaban coordenadas fuera de
   * rango) y `whitelist: true` del ValidationPipe global borraba sus propiedades, guardando
   * `{}` como evidencia de ubicación en TODA firma hecha por esta vía. Si el JSON es inválido se
   * deja el valor tal cual para que la validación falle con un 400 claro en vez de reventar aquí.
   */
  @ApiProperty({
    type: GeolocationDto,
    description:
      'Obligatoria. Serializado como JSON string dentro del multipart/form-data (ver @Transform).',
  })
  @IsDefined({
    message: 'La geolocalización es obligatoria para poder firmar el documento',
  })
  @Transform(({ value }) => {
    const raw: unknown =
      typeof value === 'string' ? tryParseJson(value) : value;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return raw;
    }
    return plainToInstance(GeolocationDto, raw);
  })
  @IsNotEmptyObject({ nullable: false })
  @ValidateNested()
  @Type(() => GeolocationDto)
  geolocation: GeolocationDto;
}

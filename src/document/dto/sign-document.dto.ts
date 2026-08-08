import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
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

export class SignDocumentDto {
  /**
   * Opcional: rechazar el permiso de ubicación en el navegador no bloquea la firma (ver
   * historia "Capturar y almacenar la geolocalización al firmar documentos") — cuando no llega,
   * `CollaboratorEntity.geoLoc` queda en null y la evidencia lo refleja como no disponible.
   */
  @ApiPropertyOptional({ type: GeolocationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GeolocationDto)
  geolocation?: GeolocationDto;
}

import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsNotEmptyObject, ValidateNested } from 'class-validator';
import { GeolocationDto } from '../../dto/sign-document.dto';

/**
 * Cuerpo de `POST /document/:id/biometric-signature`.
 *
 * Sólo la ubicación: es la misma evidencia obligatoria que pide `PATCH /document/:id/sign`, y se
 * pide al INICIAR porque la firma se registra después, desde el webhook de Didit, cuando ya no hay
 * dispositivo al que preguntarle.
 *
 * A diferencia de `SignDocumentDto` llega como JSON y no como multipart, así que no hace falta su
 * `@Transform`: `@Type` basta para que `@ValidateNested` valide una instancia real.
 */
export class StartBiometricSignatureDto {
  @ApiProperty({ type: GeolocationDto })
  @IsDefined({
    message: 'La geolocalización es obligatoria para poder firmar el documento',
  })
  @IsNotEmptyObject({ nullable: false })
  @ValidateNested()
  @Type(() => GeolocationDto)
  geolocation: GeolocationDto;
}

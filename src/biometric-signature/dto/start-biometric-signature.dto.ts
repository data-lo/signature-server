import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Equals,
  IsDefined,
  IsNotEmptyObject,
  ValidateNested,
} from 'class-validator';
import { GeolocationDto } from 'src/document/dto/sign-document.dto';

/**
 * Cuerpo para iniciar la firma biométrica, con cuenta o como invitado.
 *
 * - `geolocation`: la misma evidencia obligatoria de cualquier firma. Se pide al INICIAR porque la
 *   firma se registra después, desde el webhook, cuando ya no hay navegador al que preguntarle.
 * - `biometricConsent`: aceptación explícita del tratamiento de datos biométricos para esta firma.
 *   Tiene que ser `true`; queda fechada en el intento (`consented_at`).
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

  @ApiProperty({
    example: true,
    description:
      'Consentimiento explícito para el tratamiento de datos biométricos en esta firma. Debe ser true.',
  })
  @Equals(true, {
    message:
      'Debes aceptar el tratamiento de tus datos biométricos para firmar con biometría',
  })
  biometricConsent: boolean;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { SIGNATURE_CAPTURE_CHANNEL_ENUM } from '../enums/signature-capture-channel.enum';

/**
 * Lo único que el cliente decide al abrir una captura es por dónde va a firmar.
 *
 * No hay `userId` en el cuerpo, ni lo habrá: el dueño de la sesión sale del token autenticado.
 * Un campo así, aunque se validara, sería una invitación permanente a firmar por otro.
 */
export class CreateSignatureCaptureSessionDto {
  @ApiProperty({
    enum: SIGNATURE_CAPTURE_CHANNEL_ENUM,
    example: SIGNATURE_CAPTURE_CHANNEL_ENUM.MOBILE_QR,
    description:
      'DESKTOP para firmar en el canvas de esta misma computadora; MOBILE_QR para generar el código que se escanea con el teléfono.',
  })
  @IsEnum(SIGNATURE_CAPTURE_CHANNEL_ENUM, {
    message: 'channel debe ser DESKTOP o MOBILE_QR',
  })
  channel: SIGNATURE_CAPTURE_CHANNEL_ENUM;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

import { SignDocumentDto } from 'src/document/dto/sign-document.dto';

/**
 * Datos de la invitación que el invitado trae en el enlace de su correo (`collabId` y `email`).
 * Sólo IDENTIFICAN la invitación: no prueban nada. El código se envía al correo guardado del
 * colaborador, no a éste.
 */
export class GuestAdvancedInvitationDto {
  @ApiProperty({ format: 'uuid', description: 'Colaborador de la invitación' })
  @IsUUID()
  collaboratorId: string;

  /**
   * Opcional, igual que en la firma biométrica de invitado: la pantalla pública
   * `/public/documents/:id/sign` sólo conoce el colaborador y el correo enmascarado. Cuando viene,
   * se compara con el guardado como verificación adicional; nunca autoriza nada.
   */
  @ApiPropertyOptional({
    example: 'ana@correo.mx',
    description: 'Correo invitado (opcional)',
  })
  @IsOptional()
  @IsEmail()
  email?: string;
}

/** Datos de la invitación más el código que llegó al correo. */
export class VerifyGuestAdvancedAccessCodeDto extends GuestAdvancedInvitationDto {
  @ApiProperty({ example: '123456', description: 'Código de 6 dígitos' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos' })
  code: string;
}

/**
 * Firma FIEL del invitado: contraseña y geolocalización como en `PATCH /document/:id/sign`
 * (multipart, con `key` y `cer` como archivos), más el hash del PDF que revisó.
 */
export class SignGuestAdvancedDocumentDto extends SignDocumentDto {
  @ApiProperty({
    example: 'b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78',
    description:
      'SHA-256 (hex) del documento que el invitado revisó, tal como lo publicó GET document. Si ya no es el vigente, la firma se rechaza.',
  })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i, {
    message: 'El hash del documento no es válido',
  })
  documentHash: string;
}

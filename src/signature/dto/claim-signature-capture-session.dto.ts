import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * El token generado tiene 43 caracteres (32 bytes en base64url). El tope se deja holgado para no
 * atarse al tamaño exacto, pero acotado: sin él, el endpoint aceptaría megabytes de basura por
 * petición sólo para terminar calculando un hash que no va a coincidir con nada.
 */
const MAX_TOKEN_LENGTH = 128;

export class ClaimSignatureCaptureSessionDto {
  @ApiProperty({
    example: 'kZ8n0Yl3Qw6bR2vXpF1sT9uH4jE7cA5dG0iM8oN2kL',
    description:
      'Token de un solo uso que venía dentro del código QR. No es un JWT ni lleva datos del usuario: es un valor aleatorio opaco, y de él en base sólo existe el hash.',
    maxLength: MAX_TOKEN_LENGTH,
  })
  @IsString()
  @IsNotEmpty({ message: 'El token del código QR es obligatorio' })
  @MaxLength(MAX_TOKEN_LENGTH)
  token: string;
}

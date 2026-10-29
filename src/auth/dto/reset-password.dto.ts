import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { Match } from '../validators/match.decorator';

export class ResetPasswordDto {
  @ApiProperty({
    description: 'Token de corta duración devuelto por /auth/verify-reset-code',
  })
  @IsString()
  @IsNotEmpty()
  resetToken: string;

  @ApiProperty({
    example: 'supersecret123',
    description: 'Nueva contraseña (mínimo 8 caracteres)',
  })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  newPassword: string;

  @ApiProperty({
    example: 'supersecret123',
    description: 'Confirmación de la nueva contraseña',
  })
  @IsString()
  @Match('newPassword', { message: 'Las contraseñas no coinciden' })
  confirmPassword: string;
}

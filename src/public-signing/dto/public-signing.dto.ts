import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

/** Código de 6 dígitos que llegó al correo de la invitación. Nada más: el resto sale del token. */
export class VerifySigningInvitationCodeDto {
  @ApiProperty({ example: '123456', description: 'Código de 6 dígitos' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos' })
  code: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length } from 'class-validator';

export class AcceptInvitationDto {
  @ApiProperty({
    example: 'PELJ850101ABC',
    description: 'RFC del usuario que acepta la invitación (12 o 13 caracteres alfanuméricos)',
  })
  @IsString()
  @IsNotEmpty()
  @Length(12, 13)
  rfc: string;
}

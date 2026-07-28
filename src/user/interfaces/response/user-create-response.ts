import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';

export class UserCreateData {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID del usuario',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({ example: 'JUAN', description: 'Nombre(s) del usuario' })
  firstName: string;

  @ApiProperty({ example: 'PÉREZ LÓPEZ', description: 'Apellidos del usuario' })
  lastName: string;

  @ApiProperty({
    example: 'juan.perez@empresa.com',
    description: 'Correo electrónico del usuario',
  })
  email: string;

  @ApiProperty({
    example: ['signer'],
    description: 'Roles asignados al usuario',
    type: [String],
  })
  roles: string[];

  @ApiProperty({
    example: 'PELJ850101HDFRNN08',
    description: 'Identificador nacional del usuario (CURP, 18 caracteres)',
    minLength: 18,
    maxLength: 18,
  })
  nationalId: string;
}

export class UserCreateResponse extends BaseResponse<UserCreateData> {
  @ApiProperty({
    type: UserCreateData,
    description: 'Datos del usuario creado',
  })
  data: UserCreateData;
}

import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';

export class SignatureUrlDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID de la firma',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({
    example: 'https://storage.example.com/firma.png?token=...',
    description: 'URL segura de la firma',
  })
  secureUrl: string;

  @ApiProperty({
    example: 86400,
    description: 'Tiempo de expiración de la URL en segundos',
  })
  expiresIn: number;
}

export class UserGetData {
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
    example: 'GERENTE TI',
    description: 'Cargo o puesto del usuario',
    nullable: true,
  })
  position: string | null;

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

  @ApiProperty({
    example: '5512345678',
    description: 'Número de teléfono de contacto (información personal)',
    nullable: true,
  })
  phoneNumber: string | null;

  @ApiProperty({
    example: 'juan.perez@personal.com',
    description: 'Correo electrónico secundario (información personal)',
    nullable: true,
  })
  secondaryEmail: string | null;

  @ApiProperty({
    type: SignatureUrlDto,
    description:
      'URL de la firma del usuario, presente solo si se solicita con withSignature=true',
    nullable: true,
    required: false,
  })
  signature?: SignatureUrlDto | null;

  @ApiProperty({
    type: SignatureUrlDto,
    description:
      'URL de la identificación oficial (INE) del usuario, presente solo si se solicita con withSignature=true',
    nullable: true,
    required: false,
  })
  officialFile?: SignatureUrlDto | null;
}

export class UserGetResponse extends BaseResponse {
  @ApiProperty({
    type: UserGetData,
    description: 'Datos del usuario encontrado',
  })
  data: UserGetData;
}

export class UserGetListResponse extends BaseResponse {
  @ApiProperty({
    type: [UserGetData],
    description: 'Lista de usuarios activos',
  })
  data: UserGetData[];
}

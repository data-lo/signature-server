import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';

export class PersonalInformationData {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID de la información personal',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({ example: 'Juan', description: 'Nombre(s)' })
  name: string;

  @ApiProperty({ example: 'Pérez López', description: 'Apellidos' })
  lastName: string;

  @ApiProperty({
    example: 'PELJ850101HDFRNN08',
    description: 'CURP (18 caracteres)',
  })
  curp: string;

  @ApiProperty({
    example: 'PELJ850101ABC',
    description: 'RFC del usuario',
    nullable: true,
  })
  rfc: string | null;

  @ApiProperty({
    example: '5512345678',
    description: 'Número de teléfono de contacto',
    nullable: true,
  })
  phoneNumber: string | null;

  @ApiProperty({
    example: 'juan.perez@personal.com',
    description: 'Correo electrónico secundario',
    nullable: true,
  })
  secondaryEmail: string | null;
}

export class PersonalInformationResponse extends BaseResponse<PersonalInformationData> {
  @ApiProperty({
    type: PersonalInformationData,
    description: 'Datos de información personal actualizados',
  })
  data: PersonalInformationData;
}

import { ApiProperty } from '@nestjs/swagger';
import { ApiResponseDto } from '../../../interfaces/api-response.dto';

export class UserGetData {
    @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del usuario', format: 'uuid' })
    id: string;

    @ApiProperty({ example: 'JUAN', description: 'Nombre(s) del usuario' })
    firstName: string;

    @ApiProperty({ example: 'PÉREZ LÓPEZ', description: 'Apellidos del usuario' })
    lastName: string;

    @ApiProperty({ example: 'juan.perez@empresa.com', description: 'Correo electrónico del usuario' })
    email: string;

    @ApiProperty({ example: 'GERENTE TI', description: 'Cargo o puesto del usuario', nullable: true })
    position: string | null;

    @ApiProperty({ example: ['signer'], description: 'Roles asignados al usuario', type: [String] })
    roles: string[];

    @ApiProperty({
        example: 'PELJ850101HDFRNN08',
        description: 'Identificador nacional del usuario (CURP, 18 caracteres)',
        minLength: 18,
        maxLength: 18
    })
    nationalId: string;

    @ApiProperty({
        example:"a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        description: 'UUID de la firma del usuario, null si no tiene firma registrada',
        format: 'uuid',
    })
    signatureId: string;
}

export class UserGetResponseDto extends ApiResponseDto {
    @ApiProperty({ type: UserGetData, description: 'Datos del usuario encontrado' })
    data: UserGetData;
}

export class UserGetListResponseDto extends ApiResponseDto {
    @ApiProperty({ type: [UserGetData], description: 'Lista de usuarios activos' })
    data: UserGetData[];
}
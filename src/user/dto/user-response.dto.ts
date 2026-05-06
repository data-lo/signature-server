import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UserResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del usuario', format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Juan', description: 'Nombre(s) del usuario' })
  firstName: string;

  @ApiProperty({ example: 'Pérez López', description: 'Apellidos del usuario' })
  lastName: string;

  @ApiProperty({ example: 'juan.perez@empresa.com', description: 'Correo electrónico del usuario' })
  email: string;

  @ApiPropertyOptional({ example: 'Gerente de TI', description: 'Cargo o puesto del usuario', nullable: true })
  position: string | null;

  @ApiProperty({ example: ['signer'], description: 'Roles asignados al usuario', type: [String] })
  roles: string[];

  @ApiProperty({ example: true, description: 'Indica si el usuario está activo' })
  isActive: boolean;

  @ApiProperty({ example: 'PELJ850101HDFRNN08', description: 'CURP del usuario (18 caracteres)' })
  nationalId: string;

  @ApiPropertyOptional({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID de la firma asociada al usuario', format: 'uuid', nullable: true })
  signatureId: string | null;

  @ApiProperty({ example: '2024-01-15T10:30:00Z', description: 'Fecha de creación del registro' })
  createdAt: Date;

  @ApiProperty({ example: '2024-01-15T10:30:00Z', description: 'Fecha de última actualización' })
  updatedAt: Date;
}

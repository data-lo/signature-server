import { ApiProperty } from '@nestjs/swagger';

/** Un contacto del directorio tal como lo publica la API. */
export class DirectoryContactResponse {
  @ApiProperty({
    format: 'uuid',
    example: '6a1f2c4e-8d3b-4f7a-9c2e-1b5d7e9f0a3c',
  })
  id: string;

  @ApiProperty({ example: 'Ana' })
  firstName: string;

  @ApiProperty({ example: 'García López' })
  lastName: string;

  @ApiProperty({
    example: 'ana.garcia@example.com',
    description: 'Correo normalizado (recortado y en minúsculas).',
  })
  email: string;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    example: null,
    description:
      'Cuenta PERSONAL del usuario de la plataforma con ese correo; null si el contacto es externo.',
  })
  linkedPersonalAccountId: string | null;

  @ApiProperty({ example: '2026-10-07T17:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-10-07T17:00:00.000Z' })
  updatedAt: Date;
}

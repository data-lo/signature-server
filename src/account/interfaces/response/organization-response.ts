import { ApiProperty } from '@nestjs/swagger';

import { BaseResponse } from '../../../interfaces/api-response.dto';

/**
 * El perfil de una organización tal como lo publica `GET /organizations/:organizationId`: los
 * mismos campos que `PATCH /organizations/:organizationId` sabe escribir, para que lo que se
 * guarda se pueda leer.
 *
 * `indexDocuments` viaja desde que la pantalla tiene un interruptor para él ("Búsqueda
 * inteligente"): la misma lectura surte esa tarjeta y decide si se ofrece indexar al crear un
 * documento.
 */
export class OrganizationProfileData {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID de la organización (tabla organizations)',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({
    example: 'Acme Corp S.A. de C.V.',
    description: 'Razón social o nombre legal completo de la empresa',
  })
  name: string;

  @ApiProperty({
    example: 'Acme',
    description:
      'Nombre de visualización: el corto con el que la organización se presenta en la interfaz',
  })
  displayName: string;

  @ApiProperty({
    example: 'ACM010101AAA',
    description: 'Identificador fiscal de la organización (en México, su RFC)',
    nullable: true,
  })
  taxId: string | null;

  @ApiProperty({
    example: '5512345678',
    description: 'Teléfono de contacto',
    nullable: true,
  })
  phoneNumber: string | null;

  @ApiProperty({
    example: 'Av. Reforma 123, CDMX',
    description: 'Domicilio fiscal',
    nullable: true,
  })
  address: string | null;

  @ApiProperty({
    example: 'acme.com',
    description:
      'Dominio de correo permitido para los miembros de la organización',
    nullable: true,
  })
  domainAllowed: string | null;

  @ApiProperty({
    example: true,
    description: 'Si la organización está vigente',
  })
  isActive: boolean;

  @ApiProperty({
    example: true,
    description:
      'Si los documentos de la organización pueden entrar a Búsqueda Inteligente',
  })
  indexDocuments: boolean;
}

export class OrganizationProfileResponse extends BaseResponse<OrganizationProfileData> {
  @ApiProperty({
    type: OrganizationProfileData,
    description: 'Perfil de la organización',
  })
  data: OrganizationProfileData;
}

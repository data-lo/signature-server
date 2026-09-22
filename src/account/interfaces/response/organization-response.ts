import { ApiProperty } from '@nestjs/swagger';

import { BaseResponse } from '../../../interfaces/api-response.dto';

/**
 * El perfil de una organización tal como lo publica `GET /organizations/:organizationId`: los
 * mismos campos que `PATCH /account/:id` sabe escribir, para que lo que se guarda se pueda leer.
 *
 * `indexDocuments` no viaja: no es información de la organización sino una preferencia sobre qué
 * hacemos con sus documentos, y la pantalla que consume esto no la muestra.
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
    description: 'RFC de la organización',
    nullable: true,
  })
  rfc: string | null;

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
}

export class OrganizationProfileResponse extends BaseResponse<OrganizationProfileData> {
  @ApiProperty({
    type: OrganizationProfileData,
    description: 'Perfil de la organización',
  })
  data: OrganizationProfileData;
}

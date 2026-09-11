import { ApiProperty } from '@nestjs/swagger';

/**
 * Un permiso estático tal como lo publica la API para pintarlo en pantalla.
 *
 * `key` y `description` no son columnas: se derivan de `resource`+`action`+`scope` en
 * `src/roles/permission-catalog.util.ts`. Es lo que permite que la pantalla de miembros muestre
 * "Firmar en nombre propio e incluirse como firmante" en vez de `DOCUMENT / SIGN / SELF`.
 */
export class RolePermissionData {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID del permiso en la tabla `permissions`',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({
    example: 'DOCUMENT.READ_OWN',
    description:
      'Clave estable derivada de recurso, acción y alcance (el alcance ANY no se sufija)',
  })
  key: string;

  @ApiProperty({ example: 'DOCUMENT', description: 'Recurso del permiso' })
  resource: string;

  @ApiProperty({ example: 'READ', description: 'Acción del permiso' })
  action: string;

  @ApiProperty({
    example: 'OWN',
    description: 'Alcance: ANY, OWN, ORGANIZATION o SELF',
  })
  scope: string;

  @ApiProperty({
    example: 'Consultar documentos propios o donde el miembro sea firmante.',
    description: 'Qué habilita, en lenguaje de negocio',
  })
  description: string;

  @ApiProperty({
    example: true,
    description:
      'Si pertenece al catálogo de permisos estáticos de organización; false para la rejilla CRUD heredada del seed de roles',
  })
  isStaticCatalog: boolean;
}

import { ApiProperty } from '@nestjs/swagger';

import { ACCOUNT_TYPE_ENUM } from 'src/account/enums/account-type.enum';
import { STATIC_PERMISSION_KEY_ENUM } from 'src/roles/static-permission-catalog';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';

/**
 * Lo que la cuenta activa puede hacer, resuelto para el usuario autenticado.
 *
 * Es el contrato que el frontend consume una vez por render del dashboard para pintar el menú y
 * las acciones. **No autoriza nada**: la autorización definitiva sigue siendo de los Guards de
 * cada endpoint, y este contexto existe para que la interfaz no ofrezca botones que el backend
 * va a rechazar.
 */
export class AuthorizationContextData {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description:
      'Membresía activa: la fila de `accounts` desde la que actúa el usuario',
    format: 'uuid',
  })
  accountId: string;

  @ApiProperty({
    example: ACCOUNT_TYPE_ENUM.ORGANIZATION,
    enum: ACCOUNT_TYPE_ENUM,
    description: 'Si la cuenta activa es personal o de organización',
  })
  accountType: ACCOUNT_TYPE_ENUM;

  @ApiProperty({
    example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    nullable: true,
    description:
      'Organización de la cuenta activa; `null` en una cuenta PERSONAL',
  })
  organizationId: string | null;

  @ApiProperty({
    example: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
    nullable: true,
    description:
      'Rol de la membresía; `null` mientras no se le haya asignado uno (invitación a medio completar)',
  })
  roleId: string | null;

  /**
   * El NOMBRE del rol, junto al identificador que ya se publicaba.
   *
   * Sin esto el cliente recibe un UUID que no puede interpretar: para decidir algo que dependa
   * del rol —comprobar que quien acaba de crear una organización quedó como su propietario, por
   * ejemplo— tendría que pedir aparte el catálogo de roles y cruzarlo a mano.
   *
   * Que sea un nombre y no un enum es deliberado: además de OWNER/ADMIN/MEMBER, una organización
   * puede definir roles propios, y el contrato tiene que poder nombrarlos igual.
   */
  @ApiProperty({
    example: SYSTEM_ROLE_NAME_ENUM.OWNER,
    nullable: true,
    description:
      'Nombre del rol de la membresía; `null` mientras no se le haya asignado uno',
  })
  roleName: string | null;

  @ApiProperty({
    example: [
      STATIC_PERMISSION_KEY_ENUM.ORGANIZATION_READ,
      STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE,
      STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_OWN,
    ],
    isArray: true,
    enum: STATIC_PERMISSION_KEY_ENUM,
    description:
      'Claves del catálogo estático que otorga el rol, en el orden en que la UI las lista',
  })
  permissions: STATIC_PERMISSION_KEY_ENUM[];
}

/** Envoltorio estándar de la API para `GET /api/v1/authorization/context`. */
export class AuthorizationContextResponse {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ example: 'Contexto de autorización obtenido correctamente' })
  message: string;

  @ApiProperty({ type: AuthorizationContextData })
  data: AuthorizationContextData;
}

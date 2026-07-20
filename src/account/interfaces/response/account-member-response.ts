import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';

export class AccountMemberData {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID de la membresía o acceso',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID de la organización a la que se le da acceso',
    format: 'uuid',
    nullable: true,
  })
  organizationId: string | null;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID del usuario que recibe el acceso',
    format: 'uuid',
  })
  userId: string;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description:
      'UUID del rol asignado en esa cuenta (ver GET /api/v1/roles); NULL si aún no se le ha asignado uno',
    format: 'uuid',
    nullable: true,
  })
  roleId: string | null;

  @ApiProperty({
    example: 'Gerente de TI',
    description: 'Puesto o cargo oficial del usuario',
    nullable: true,
  })
  position: string | null;

  @ApiProperty({
    example: true,
    description: 'Define si el acceso del usuario a este entorno está vigente',
  })
  isActive: boolean;
}

export class AccountMemberResponse extends BaseResponse<AccountMemberData> {
  @ApiProperty({
    type: AccountMemberData,
    description: 'Datos de la membresía',
  })
  data: AccountMemberData;
}

export class AccountMemberListResponse extends BaseResponse<
  AccountMemberData[]
> {
  @ApiProperty({
    type: [AccountMemberData],
    description: 'Lista de membresías',
  })
  data: AccountMemberData[];
}

class OrganizationMemberRole {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'MEMBER' })
  name: string;
}

/**
 * Shape delgado para la sección de gestión de miembros (ver historia [STORY] Gestión de
 * Miembros): solo lo que la tabla del frontend necesita, en vez de la AccountEntity completa
 * que devuelve AccountMemberData. `rfc` sale de `users.personal_information` (join adicional,
 * ver `AccountMemberService.findMembersForOrganizationDetailed`).
 */
export class OrganizationMemberData {
  @ApiProperty({ format: 'uuid' })
  accountId: string;

  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty({ example: 'usuario@mail.com' })
  email: string;

  @ApiProperty({ example: 'XAXX010101000', nullable: true })
  rfc: string | null;

  @ApiProperty({ type: OrganizationMemberRole, nullable: true })
  role: OrganizationMemberRole | null;

  @ApiProperty({ example: '2023-10-25T10:00:00Z', nullable: true })
  joinedAt: Date | null;
}

export class OrganizationMemberListResponse extends BaseResponse<
  OrganizationMemberData[]
> {
  @ApiProperty({ type: [OrganizationMemberData] })
  data: OrganizationMemberData[];
}

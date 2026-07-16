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
    description: 'UUID de la cuenta a la que se le da acceso',
    format: 'uuid',
  })
  accountId: string;

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

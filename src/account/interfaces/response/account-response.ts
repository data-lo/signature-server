import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';
import { ACCOUNT_TYPE_ENUM } from '../../enums/account-type.enum';

export class OrganizationDetailData {
  @ApiProperty({
    example: 'Acme Corp S.A. de C.V.',
    description: 'Razón social o nombre legal completo de la empresa',
  })
  name: string;
}

export class AccountData {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID de la cuenta',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({
    example: 'Acme Corp',
    description: 'Nombre de visualización del espacio de trabajo',
  })
  name: string;

  @ApiProperty({
    example: ACCOUNT_TYPE_ENUM.ORGANIZATION,
    description: 'Tipo de entorno de la cuenta',
    enum: ACCOUNT_TYPE_ENUM,
  })
  type: ACCOUNT_TYPE_ENUM;

  @ApiProperty({
    example: '2026-07-04T12:00:00.000Z',
    description: 'Fecha de creación del espacio de trabajo',
  })
  createdAt: Date;

  @ApiProperty({
    type: OrganizationDetailData,
    description:
      'Datos corporativos, presentes solo si el type de la cuenta es ORGANIZATION',
    nullable: true,
    required: false,
  })
  organizationDetail?: OrganizationDetailData | null;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description:
      'UUID del rol (ver GET /api/v1/roles) del usuario autenticado en esta cuenta; NULL si todavía no se le ha asignado uno explícitamente (la columna admite NULL, aunque hoy el creador de una cuenta personal u organización siempre queda con el rol ADMIN de inmediato)',
    format: 'uuid',
    nullable: true,
  })
  roleId: string | null;

  @ApiProperty({
    example: true,
    description:
      'Vigencia de la membresía del usuario autenticado en esta cuenta',
  })
  isActive: boolean;
}

export class AccountResponse extends BaseResponse<AccountData> {
  @ApiProperty({ type: AccountData, description: 'Datos de la cuenta' })
  data: AccountData;
}

export class AccountListResponse extends BaseResponse<AccountData[]> {
  @ApiProperty({ type: [AccountData], description: 'Lista de cuentas' })
  data: AccountData[];
}

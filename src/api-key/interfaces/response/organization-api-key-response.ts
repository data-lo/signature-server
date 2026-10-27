import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { ApiKeyStatusEnum } from '../../enums/api-key-status.enum';
import {
  API_KEY_ERROR_CODE_ENUM,
  ApiKeyErrorBody,
} from '../../exceptions/api-key.exceptions';

/** Un permiso concedido a la llave, con su clave derivada del catálogo. */
export class OrganizationApiKeyPermissionData {
  @ApiProperty({
    example: '8f0c6f8e-3b8b-4c55-9d43-1f2b7f0f0a11',
    format: 'uuid',
    description: 'Id del permiso en `permissions`',
  })
  id: string;

  @ApiProperty({
    example: 'DOCUMENT.CREATE',
    description: 'Clave `RECURSO.ACCION[_ALCANCE]` del permiso',
  })
  key: string;
}

/**
 * Metadatos de una llave. Nunca incluye el secreto ni su hash: el secreto sólo viaja en
 * `IssuedOrganizationApiKeyData.key`, al emitirla.
 */
export class OrganizationApiKeyData {
  @ApiProperty({
    example: 'b3c1…',
    format: 'uuid',
    description: 'Id de la llave',
  })
  id: string;

  @ApiProperty({
    example: 'Integración ERP',
    description: 'Nombre administrativo',
  })
  name: string;

  @ApiProperty({
    example: 'fma_live_3f9a0c1b2d4e5f60',
    description:
      'Prefijo visible con el que se reconoce la llave; no contiene el secreto',
  })
  prefix: string;

  @ApiProperty({ enum: ApiKeyStatusEnum, example: ApiKeyStatusEnum.ACTIVE })
  status: ApiKeyStatusEnum;

  @ApiProperty({ type: [OrganizationApiKeyPermissionData] })
  permissions: OrganizationApiKeyPermissionData[];

  @ApiProperty({ example: '2026-10-26T12:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({
    example: null,
    nullable: true,
    type: Date,
    description: 'Último uso exitoso; `null` si nunca se usó',
  })
  lastUsedAt: Date | null;

  @ApiProperty({
    example: '2027-10-26T00:00:00.000Z',
    nullable: true,
    type: Date,
    description: '`null` si la llave no vence',
  })
  expiresAt: Date | null;

  @ApiProperty({ example: null, nullable: true, type: Date })
  revokedAt: Date | null;

  @ApiProperty({
    example: 'a1b2…',
    format: 'uuid',
    description: 'Membresía (`accounts.id`) que emitió la llave',
  })
  createdByAccountId: string;

  @ApiProperty({
    example: null,
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'Membresía que la revocó; `null` si sigue vigente',
  })
  revokedByAccountId: string | null;
}

/** Llave recién emitida: los metadatos más la llave completa, que no se vuelve a mostrar. */
export class IssuedOrganizationApiKeyData extends OrganizationApiKeyData {
  @ApiProperty({
    example: 'fma_live_3f9a0c1b2d4e5f60_Qm9vZGxlIGJvb2RsZSBib29kbGUgYm9vZGxl',
    description:
      'La API key completa. Sólo se entrega en esta respuesta: guárdala ahora, no se puede recuperar.',
  })
  key: string;
}

export class OrganizationApiKeyResponse extends BaseResponse<OrganizationApiKeyData> {
  @ApiProperty({ type: OrganizationApiKeyData })
  data: OrganizationApiKeyData;
}

export class OrganizationApiKeyListResponse extends BaseResponse<
  OrganizationApiKeyData[]
> {
  @ApiProperty({ type: [OrganizationApiKeyData] })
  data: OrganizationApiKeyData[];
}

export class IssuedOrganizationApiKeyResponse extends BaseResponse<IssuedOrganizationApiKeyData> {
  @ApiProperty({ type: IssuedOrganizationApiKeyData })
  data: IssuedOrganizationApiKeyData;
}

/** Cuerpo de error de estos endpoints, para Swagger. */
export class OrganizationApiKeyErrorResponse implements ApiKeyErrorBody {
  @ApiProperty({ example: 409 })
  statusCode: number;

  @ApiProperty({ example: 'Conflict' })
  error: string;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: 'La organización ya tiene una API key activa.',
  })
  message: string | string[];

  @ApiPropertyOptional({
    enum: API_KEY_ERROR_CODE_ENUM,
    example: API_KEY_ERROR_CODE_ENUM.API_KEY_ALREADY_ACTIVE,
  })
  code: API_KEY_ERROR_CODE_ENUM;
}

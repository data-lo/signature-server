import { ApiProperty } from '@nestjs/swagger';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM } from '../enums/outbound-webhook-event-type.enum';
import { WEBHOOK_ENDPOINT_STATUS_ENUM } from '../enums/webhook-endpoint-status.enum';

/** Configuración del endpoint de webhooks de la organización, sin el secreto. */
export class IntegrationWebhookEndpointData {
  @ApiProperty({
    format: 'uuid',
    example: '0c7a4f2e-9d1b-4e6a-8f3c-2b5d7e9a1c40',
  })
  id: string;

  @ApiProperty({ example: 'https://erp.cliente.com/webhooks/firmalo' })
  url: string;

  @ApiProperty({
    enum: WEBHOOK_ENDPOINT_STATUS_ENUM,
    example: WEBHOOK_ENDPOINT_STATUS_ENUM.ACTIVE,
    description:
      '`ACTIVE` registra entregas para los eventos suscritos. `DISABLED` no registra entregas nuevas; las ya registradas se siguen enviando.',
  })
  status: WEBHOOK_ENDPOINT_STATUS_ENUM;

  @ApiProperty({
    enum: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM,
    isArray: true,
    example: Object.values(OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM),
  })
  events: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM[];

  @ApiProperty({
    example: 1,
    description:
      'Versión del secreto activo. Sube en 1 con cada rotación; el secreto nunca se vuelve a mostrar.',
  })
  secretVersion: number;

  @ApiProperty({ format: 'date-time', example: '2026-11-12T18:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-12T18:00:00.000Z' })
  updatedAt: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'Cuándo se desactivó; `null` mientras está `ACTIVE`.',
  })
  disabledAt: string | null;
}

/** Configuración recién creada o con el secreto recién rotado: la única vez que viaja el secreto. */
export class IntegrationWebhookEndpointWithSecretData extends IntegrationWebhookEndpointData {
  @ApiProperty({
    example: 'whsec_ZXhhbXBsZS1ub3QtYS1yZWFsLXNlY3JldC0xMjM0NTY3ODk',
    description:
      'Secreto HMAC completo (`whsec_` incluido). **Sólo se entrega en esta respuesta**: guárdalo en el gestor de secretos de tu backend. Si se pierde, rótalo.',
  })
  secret: string;
}

export class IntegrationWebhookEndpointResponse extends BaseResponse<IntegrationWebhookEndpointData> {
  @ApiProperty({ example: 'Endpoint de webhooks obtenido correctamente' })
  message: string;

  @ApiProperty({ type: IntegrationWebhookEndpointData })
  data: IntegrationWebhookEndpointData;
}

export class IntegrationWebhookEndpointWithSecretResponse extends BaseResponse<IntegrationWebhookEndpointWithSecretData> {
  @ApiProperty({ example: 'Endpoint de webhooks creado correctamente' })
  message: string;

  @ApiProperty({ type: IntegrationWebhookEndpointWithSecretData })
  data: IntegrationWebhookEndpointWithSecretData;
}

/**
 * Respuesta de `PUT`: al crear trae el secreto (201); al actualizar, no (200). Swagger documenta
 * cada caso con su propia clase; ésta es el tipo que devuelve el caso de uso.
 */
export type IntegrationUpsertWebhookEndpointResult = {
  created: boolean;
  response: BaseResponse<
    IntegrationWebhookEndpointData | IntegrationWebhookEndpointWithSecretData
  >;
};

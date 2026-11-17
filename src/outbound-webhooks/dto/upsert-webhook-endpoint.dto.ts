import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsString,
  MaxLength,
} from 'class-validator';

import { OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM } from '../enums/outbound-webhook-event-type.enum';
import { WEBHOOK_URL_MAX_LENGTH } from '../services/webhook-endpoint-url-policy.service';

/** Cuerpo de `PUT /integration/webhooks/endpoint`. */
export class UpsertWebhookEndpointDto {
  @ApiProperty({
    example: 'https://erp.cliente.com/webhooks/firmalo',
    maxLength: WEBHOOK_URL_MAX_LENGTH,
    description:
      'URL que recibe los `POST`. Sólo `https://` en el puerto 443, sin usuario ni contraseña, a un host público: se rechazan IPs privadas, loopback, link-local y metadatos de nube.',
  })
  @IsString()
  @MaxLength(WEBHOOK_URL_MAX_LENGTH)
  url: string;

  @ApiProperty({
    enum: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM,
    isArray: true,
    minItems: 1,
    uniqueItems: true,
    example: Object.values(OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM),
    description: 'Eventos que se notifican; al menos uno, sin repetir.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsEnum(OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM, { each: true })
  events: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM[];
}

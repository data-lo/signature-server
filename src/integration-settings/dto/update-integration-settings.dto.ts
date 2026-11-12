import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Cuerpo de `PATCH /integration/settings`.
 *
 * Sólo admite `webhooksEnabled`. La organización sale de la API key: un `organizationId` responde
 * `400 INTEGRATION_TENANT_OVERRIDE_NOT_ALLOWED`, y cualquier otro campo (URL, secreto…) `422
 * INVALID_REQUEST` (ver `assertOnlyIntegrationSettingsFields`).
 */
export class UpdateIntegrationSettingsDto {
  @ApiProperty({
    type: Boolean,
    example: true,
    description:
      'Si los eventos de firma de los documentos creados con la API generan webhooks hacia tu sistema.',
  })
  @IsBoolean({ message: 'webhooksEnabled debe ser true o false' })
  webhooksEnabled: boolean;
}

/** Campos que acepta el cuerpo de `PATCH /integration/settings`. */
export const UPDATE_INTEGRATION_SETTINGS_FIELDS: ReadonlySet<string> = new Set([
  'webhooksEnabled',
]);

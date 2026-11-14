import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Cuerpo de `PATCH /integration/settings` (API de integración, con API key).
 *
 * Sólo admite `webhooksEnabled`. La organización sale de la API key: un `organizationId` responde
 * `400 INTEGRATION_TENANT_OVERRIDE_NOT_ALLOWED`, y cualquier otro campo (URL, secreto, `status`…)
 * `422 INVALID_REQUEST` (ver `assertOnlyIntegrationApiSettingsFields`). El interruptor `status` lo
 * administra un miembro desde `PATCH /organizations/:organizationId/integration-settings`.
 */
export class UpdateIntegrationApiSettingsDto {
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
export const UPDATE_INTEGRATION_API_SETTINGS_FIELDS: ReadonlySet<string> =
  new Set(['webhooksEnabled']);

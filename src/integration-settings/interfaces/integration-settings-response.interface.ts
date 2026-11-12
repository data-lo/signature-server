import { ApiProperty } from '@nestjs/swagger';

import { IntegrationSettingsEntity } from '../entities/integration-settings.entity';

/** Opciones configurables de la integración; nunca incluye ids internos ni datos de API keys. */
export class IntegrationSettingsData {
  @ApiProperty({
    type: Boolean,
    example: false,
    description:
      'Si los eventos de firma de los documentos creados con la API generan webhooks. `false` mientras no se haya configurado.',
  })
  webhooksEnabled: boolean;
}

/** Respuesta de `GET` y `PATCH /integration/settings`. */
export class IntegrationSettingsResponse {
  @ApiProperty({ example: true })
  success: true;

  @ApiProperty({ type: IntegrationSettingsData })
  data: IntegrationSettingsData;
}

/**
 * Arma la respuesta pública. Sin fila, los valores por defecto: `webhooksEnabled: false`.
 *
 * @param settings - Configuración guardada, o `null` si no existe.
 * @returns La respuesta con las opciones configurables.
 *
 * @example
 * ```ts
 * toIntegrationSettingsResponse(null); // { success: true, data: { webhooksEnabled: false } }
 * ```
 */
export function toIntegrationSettingsResponse(
  settings: IntegrationSettingsEntity | null,
): IntegrationSettingsResponse {
  return {
    success: true,
    data: { webhooksEnabled: settings?.webhooksEnabled ?? false },
  };
}

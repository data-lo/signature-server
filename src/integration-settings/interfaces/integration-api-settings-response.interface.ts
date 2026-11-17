import { ApiProperty } from '@nestjs/swagger';

import { IntegrationSettingsEntity } from '../entities/integration-settings.entity';

/**
 * Opciones de la integración que configura el sistema del cliente con su API key; nunca incluye
 * ids internos, el `status` administrativo ni datos de API keys.
 */
export class IntegrationApiSettingsData {
  @ApiProperty({
    type: Boolean,
    example: false,
    description:
      'Si los eventos de firma de los documentos creados con la API generan webhooks. `false` mientras no se haya configurado.',
  })
  webhooksEnabled: boolean;
}

/** Respuesta de `GET` y `PATCH /integration/settings`. */
export class IntegrationApiSettingsResponse {
  @ApiProperty({ example: true })
  success: true;

  @ApiProperty({ type: IntegrationApiSettingsData })
  data: IntegrationApiSettingsData;
}

/**
 * Arma la respuesta pública. Sin fila, los valores por defecto: `webhooksEnabled: false`.
 *
 * @param settings - Configuración guardada, o `null` si no existe.
 * @returns La respuesta con las opciones configurables.
 *
 * @example
 * ```ts
 * toIntegrationApiSettingsResponse(null); // { success: true, data: { webhooksEnabled: false } }
 * ```
 */
export function toIntegrationApiSettingsResponse(
  settings: IntegrationSettingsEntity | null,
): IntegrationApiSettingsResponse {
  return {
    success: true,
    data: { webhooksEnabled: settings?.webhooksEnabled ?? false },
  };
}

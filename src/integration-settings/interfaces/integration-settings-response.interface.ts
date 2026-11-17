import { ApiProperty } from '@nestjs/swagger';

import { IntegrationSettingsEntity } from '../entities/integration-settings.entity';
import { INTEGRATION_STATUS_ENUM } from '../enums/integration-status.enum';

/** Configuración de integración que ve el administrador; nunca incluye datos de API keys. */
export class IntegrationSettingsData {
  @ApiProperty({ format: 'uuid' })
  organizationId: string;

  @ApiProperty({ enum: INTEGRATION_STATUS_ENUM })
  status: INTEGRATION_STATUS_ENUM;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      '`null` si la organización nunca emitió una API key ni cambió el estado: la integración se considera `ACTIVE`.',
  })
  createdAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  updatedAt: Date | null;
}

/**
 * Proyecta la configuración a su respuesta. Sin fila, la integración se considera `ACTIVE`, que
 * es lo mismo que aplica `OrganizationApiKeyGuard`.
 *
 * @param organizationId - Organización consultada.
 * @param settings - Configuración guardada, o `null` si no existe.
 * @returns Los datos públicos de la configuración.
 *
 * @example
 * ```ts
 * toIntegrationSettingsData('org-1', null); // { organizationId: 'org-1', status: 'ACTIVE', createdAt: null, updatedAt: null }
 * ```
 */
export function toIntegrationSettingsData(
  organizationId: string,
  settings: IntegrationSettingsEntity | null,
): IntegrationSettingsData {
  return {
    organizationId,
    status: settings?.status ?? INTEGRATION_STATUS_ENUM.ACTIVE,
    createdAt: settings?.createdAt ?? null,
    updatedAt: settings?.updatedAt ?? null,
  };
}

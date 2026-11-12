import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IntegrationSettingsEntity } from '../entities/integration-settings.entity';

/** Consulta y persiste la configuración de integración por organización. */
@Injectable()
export class IntegrationSettingsService {
  constructor(
    @InjectRepository(IntegrationSettingsEntity)
    private readonly settingsRepository: Repository<IntegrationSettingsEntity>,
  ) {}

  /**
   * Busca la configuración de una organización.
   *
   * @param organizationId - Organización de la API key.
   * @returns La configuración, o `null` si nunca se guardó.
   *
   * @example
   * ```ts
   * const settings = await service.findByOrganization('org-1'); // null si nunca hubo PATCH
   * ```
   */
  findByOrganization(
    organizationId: string,
  ): Promise<IntegrationSettingsEntity | null> {
    return this.settingsRepository.findOne({ where: { organizationId } });
  }

  /**
   * Fija `webhooksEnabled` en una sola sentencia: crea la fila si no existe y sólo la actualiza si
   * el valor cambia. Repetir el mismo valor no crea filas ni modifica `updated_at`, y dos
   * peticiones simultáneas no pueden crear dos filas (`ON CONFLICT` sobre
   * `UQ_integration_settings_organization_id`).
   *
   * @param organizationId - Organización de la API key.
   * @param webhooksEnabled - Valor deseado.
   * @returns La configuración resultante.
   *
   * @throws {QueryFailedError} Si la organización no existe (FK).
   *
   * @example
   * ```ts
   * const settings = await service.setWebhooksEnabled('org-1', true);
   * ```
   */
  async setWebhooksEnabled(
    organizationId: string,
    webhooksEnabled: boolean,
  ): Promise<IntegrationSettingsEntity> {
    await this.settingsRepository.query(
      `INSERT INTO "integration_settings" ("organization_id", "webhooks_enabled")
       VALUES ($1, $2)
       ON CONFLICT ("organization_id") DO UPDATE
         SET "webhooks_enabled" = EXCLUDED."webhooks_enabled", "updated_at" = now()
         WHERE "integration_settings"."webhooks_enabled" IS DISTINCT FROM EXCLUDED."webhooks_enabled"`,
      [organizationId, webhooksEnabled],
    );

    return this.settingsRepository.findOneOrFail({ where: { organizationId } });
  }
}

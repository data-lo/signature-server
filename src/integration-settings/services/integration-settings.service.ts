import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { OrganizationEntity } from 'src/account/entities/organization.entity';

import { IntegrationSettingsEntity } from '../entities/integration-settings.entity';
import { INTEGRATION_STATUS_ENUM } from '../enums/integration-status.enum';

/**
 * Garantiza que la organización tenga configuración de integración, creándola `ACTIVE` si no
 * existe. Si ya existe no la toca: una integración `DISABLED` sigue desactivada.
 *
 * Se llama dentro de la transacción que emite una API key (`issueApiKey`), así que la primera
 * llave de una organización y su configuración se confirman o revierten juntas. Es idempotente y
 * segura ante concurrencia: `ON CONFLICT DO NOTHING` sobre `UQ_integration_settings_organization_id`.
 *
 * @param manager - Transacción en curso.
 * @param organizationId - Organización de la llave.
 * @returns Nada.
 *
 * @throws {QueryFailedError} Si la organización no existe (FK) o falla la inserción.
 *
 * @example
 * ```ts
 * await ensureInitialIntegrationSettings(manager, 'org-1');
 * ```
 */
export async function ensureInitialIntegrationSettings(
  manager: EntityManager,
  organizationId: string,
): Promise<void> {
  await manager
    .createQueryBuilder()
    .insert()
    .into(IntegrationSettingsEntity)
    .values({ organizationId, status: INTEGRATION_STATUS_ENUM.ACTIVE })
    .orIgnore()
    .execute();
}

/** Acceso a datos de la configuración de integración. */
@Injectable()
export class IntegrationSettingsService {
  constructor(
    @InjectRepository(IntegrationSettingsEntity)
    private readonly settingsRepository: Repository<IntegrationSettingsEntity>,
    @InjectRepository(OrganizationEntity)
    private readonly organizationRepository: Repository<OrganizationEntity>,
  ) {}

  /**
   * Indica si la organización existe y está activa.
   *
   * @param organizationId - Organización de la ruta.
   * @returns `true` si existe con `isActive`.
   *
   * @example
   * ```ts
   * if (!(await service.isActiveOrganization('org-1'))) throw new IntegrationSettingsOrganizationNotFoundException();
   * ```
   */
  async isActiveOrganization(organizationId: string): Promise<boolean> {
    return this.organizationRepository.exists({
      where: { id: organizationId, isActive: true },
    });
  }

  /**
   * Busca la configuración de una organización.
   *
   * @param organizationId - Organización.
   * @returns La configuración, o `null` si nunca se creó.
   *
   * @example
   * ```ts
   * const settings = await service.findByOrganization('org-1');
   * ```
   */
  findByOrganization(
    organizationId: string,
  ): Promise<IntegrationSettingsEntity | null> {
    return this.settingsRepository.findOne({ where: { organizationId } });
  }

  /**
   * Fija el estado de la integración en una sola sentencia: crea la fila si no existe y sólo la
   * actualiza si el estado cambia. Repetir el mismo estado no modifica `updated_at`.
   *
   * @param organizationId - Organización.
   * @param status - Estado deseado.
   * @returns La configuración resultante.
   *
   * @throws {QueryFailedError} Si la organización no existe (FK).
   *
   * @example
   * ```ts
   * await service.setStatus('org-1', INTEGRATION_STATUS_ENUM.DISABLED);
   * ```
   */
  async setStatus(
    organizationId: string,
    status: INTEGRATION_STATUS_ENUM,
  ): Promise<IntegrationSettingsEntity> {
    await this.settingsRepository.query(
      `INSERT INTO "integration_settings" ("organization_id", "status")
       VALUES ($1, $2)
       ON CONFLICT ("organization_id") DO UPDATE
         SET "status" = EXCLUDED."status", "updated_at" = now()
         WHERE "integration_settings"."status" IS DISTINCT FROM EXCLUDED."status"`,
      [organizationId, status],
    );

    return this.settingsRepository.findOneOrFail({ where: { organizationId } });
  }
}

import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import { OrganizationEntity } from 'src/account/entities/organization.entity';
import { PermissionEntity } from 'src/roles/entities/permission.entity';
import { buildPermissionKey } from 'src/roles/permission-catalog.util';

import { ApiKeyEntity } from './entities/api-key.entity';
import { ApiKeyStatusEnum } from './enums/api-key-status.enum';

/** Relaciones con las que se publica una llave: sus permisos con recurso y acción. */
const API_KEY_RELATIONS = {
  permissions: { resource: true, action: true },
} as const;

/** Cómo bloquear la fila de la organización dentro de una transacción. */
export type OrganizationLockMode = 'wait' | 'nowait';

/**
 * Acceso a datos de las API keys de organización: sólo lee y escribe, sin reglas de negocio.
 *
 * Las reglas (una sola llave activa, permisos asignables, quién revoca) viven en los casos de uso
 * de `applications/`, igual que en el directorio de contactos. Los métodos que reciben un
 * `EntityManager` trabajan dentro de la transacción del llamador; los demás, fuera de ella.
 */
@Injectable()
export class ApiKeyService {
  constructor(
    @InjectRepository(ApiKeyEntity)
    private readonly apiKeyRepository: Repository<ApiKeyEntity>,
    @InjectRepository(OrganizationEntity)
    private readonly organizationRepository: Repository<OrganizationEntity>,
    @InjectRepository(PermissionEntity)
    private readonly permissionRepository: Repository<PermissionEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Ejecuta `work` en una transacción de TypeORM.
   *
   * @param work - Operaciones a confirmar juntas.
   * @returns Lo que devuelva `work`.
   *
   * @throws Lo que lance `work`; en ese caso la transacción se revierte.
   *
   * @example
   * ```ts
   * await apiKeyService.transaction((manager) => apiKeyService.saveApiKey(manager, apiKey));
   * ```
   */
  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(work);
  }

  /**
   * Busca una organización activa.
   *
   * @param organizationId - Organización de la ruta.
   * @returns La organización, o `null` si no existe o está desactivada.
   *
   * @example
   * ```ts
   * const organization = await apiKeyService.findActiveOrganization('org-1');
   * ```
   */
  findActiveOrganization(
    organizationId: string,
  ): Promise<OrganizationEntity | null> {
    return this.organizationRepository.findOneBy({
      id: organizationId,
      isActive: true,
    });
  }

  /**
   * Bloquea la fila de una organización activa (`FOR UPDATE`) hasta que termine la transacción.
   *
   * Es lo que serializa las altas y rotaciones de una misma organización: mientras una tiene la
   * fila, la otra espera (`wait`) o falla en el acto (`nowait`, SQLSTATE `55P03`).
   *
   * @param manager - Transacción en curso.
   * @param organizationId - Organización a bloquear.
   * @param mode - `wait` espera a que se libere; `nowait` falla si ya está tomada.
   * @returns La organización bloqueada, o `null` si no existe o está desactivada.
   *
   * @throws {QueryFailedError} Con `driverError.code = '55P03'` si `mode` es `nowait` y la fila
   *   está bloqueada por otra transacción.
   *
   * @example
   * ```ts
   * await apiKeyService.lockActiveOrganization(manager, 'org-1', 'nowait');
   * ```
   */
  lockActiveOrganization(
    manager: EntityManager,
    organizationId: string,
    mode: OrganizationLockMode,
  ): Promise<OrganizationEntity | null> {
    return manager
      .getRepository(OrganizationEntity)
      .createQueryBuilder('organization')
      .setLock(
        mode === 'nowait' ? 'pessimistic_write_or_fail' : 'pessimistic_write',
      )
      .where('organization.id = :organizationId', { organizationId })
      .andWhere('organization.isActive = true')
      .getOne();
  }

  /**
   * Permisos del catálogo con su recurso y su acción, para validar y publicar sus claves.
   *
   * @param permissionIds - Ids de `permissions`.
   * @returns Los que existan; los que no, simplemente no vuelven.
   *
   * @example
   * ```ts
   * const permissions = await apiKeyService.findPermissionsByIds(['perm-1', 'perm-2']);
   * ```
   */
  findPermissionsByIds(permissionIds: string[]): Promise<PermissionEntity[]> {
    if (permissionIds.length === 0) {
      return Promise.resolve([]);
    }

    return this.permissionRepository.find({
      where: { id: In(permissionIds) },
      relations: { resource: true, action: true },
    });
  }

  /**
   * Permisos del catálogo identificados por su clave derivada (`RECURSO.ACCION[_ALCANCE]`).
   *
   * Lee el catálogo completo y filtra en memoria: la clave no es una columna, se arma con
   * `buildPermissionKey` a partir del recurso, la acción y el alcance, y el catálogo tiene unas
   * decenas de filas.
   *
   * @param permissionKeys - Claves pedidas, p. ej. `DOCUMENT.CREATE`.
   * @param manager - Transacción en curso, si la hay.
   * @returns Los permisos que existan, con recurso y acción cargados; los que no, no vuelven.
   *
   * @example
   * ```ts
   * const permissions = await apiKeyService.findPermissionsByKeys(['DOCUMENT.CREATE']);
   * ```
   */
  async findPermissionsByKeys(
    permissionKeys: readonly string[],
    manager?: EntityManager,
  ): Promise<PermissionEntity[]> {
    if (permissionKeys.length === 0) {
      return [];
    }

    const wanted = new Set(permissionKeys);
    const repository = manager
      ? manager.getRepository(PermissionEntity)
      : this.permissionRepository;
    const catalog = await repository.find({
      relations: { resource: true, action: true },
    });

    return catalog.filter((permission) =>
      wanted.has(
        buildPermissionKey(
          permission.resource.key,
          permission.action.key,
          permission.scope,
        ),
      ),
    );
  }

  /**
   * La llave `ACTIVE` de la organización, con sus permisos.
   *
   * @param organizationId - Organización de la ruta.
   * @param manager - Transacción en curso, si la hay.
   * @returns La llave vigente, o `null` si no tiene.
   *
   * @example
   * ```ts
   * const current = await apiKeyService.findActiveApiKey('org-1');
   * ```
   */
  findActiveApiKey(
    organizationId: string,
    manager?: EntityManager,
  ): Promise<ApiKeyEntity | null> {
    return this.repository(manager).findOne({
      where: { organizationId, status: ApiKeyStatusEnum.ACTIVE },
      relations: API_KEY_RELATIONS,
    });
  }

  /**
   * Historial de llaves de la organización, vigente y revocadas, de la más nueva a la más vieja.
   *
   * @param organizationId - Organización de la ruta.
   * @returns Las llaves con sus permisos.
   *
   * @example
   * ```ts
   * const history = await apiKeyService.listApiKeys('org-1');
   * ```
   */
  listApiKeys(organizationId: string): Promise<ApiKeyEntity[]> {
    return this.apiKeyRepository.find({
      where: { organizationId },
      relations: API_KEY_RELATIONS,
      order: { createdAt: 'DESC', id: 'ASC' },
    });
  }

  /**
   * Una llave concreta de la organización, con sus permisos.
   *
   * @param organizationId - Organización de la ruta.
   * @param apiKeyId - Llave pedida.
   * @param manager - Transacción en curso, si la hay.
   * @returns La llave, o `null` si no existe o es de otra organización.
   *
   * @example
   * ```ts
   * const apiKey = await apiKeyService.findApiKey('org-1', 'key-1');
   * ```
   */
  findApiKey(
    organizationId: string,
    apiKeyId: string,
    manager?: EntityManager,
  ): Promise<ApiKeyEntity | null> {
    return this.repository(manager).findOne({
      where: { id: apiKeyId, organizationId },
      relations: API_KEY_RELATIONS,
    });
  }

  /**
   * Bloquea una llave de la organización (`FOR UPDATE`) hasta que termine la transacción.
   *
   * Se consulta sin relaciones: Postgres no admite `FOR UPDATE` sobre el lado opcional de un
   * `LEFT JOIN`, y los permisos se cargan después con `findApiKey`.
   *
   * @param manager - Transacción en curso.
   * @param organizationId - Organización de la ruta.
   * @param where - La llave por id, o la `ACTIVE` de la organización.
   * @returns La llave bloqueada, o `null` si no existe en esa organización.
   *
   * @example
   * ```ts
   * await apiKeyService.lockApiKey(manager, 'org-1', { status: ApiKeyStatusEnum.ACTIVE });
   * ```
   */
  lockApiKey(
    manager: EntityManager,
    organizationId: string,
    where: { id: string } | { status: ApiKeyStatusEnum },
  ): Promise<ApiKeyEntity | null> {
    return manager.getRepository(ApiKeyEntity).findOne({
      where: { ...where, organizationId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  /**
   * Inserta una llave con sus permisos (las filas de `api_key_permissions` las escribe TypeORM).
   *
   * @param manager - Transacción en curso.
   * @param apiKey - Llave a guardar, con `permissions` ya asignados.
   * @returns La llave guardada.
   *
   * @throws {QueryFailedError} Si viola una restricción de `api_keys`, p. ej. una segunda llave
   *   `ACTIVE` (`uq_api_keys_one_active_per_organization`).
   *
   * @example
   * ```ts
   * await apiKeyService.insertApiKey(manager, manager.create(ApiKeyEntity, { … }));
   * ```
   */
  insertApiKey(
    manager: EntityManager,
    apiKey: ApiKeyEntity,
  ): Promise<ApiKeyEntity> {
    return manager.getRepository(ApiKeyEntity).save(apiKey);
  }

  /**
   * Marca una llave como `REVOKED`, con quién y cuándo. No la borra.
   *
   * @param manager - Transacción en curso.
   * @param apiKeyId - Llave a revocar.
   * @param revokedByAccountId - Membresía que la revoca.
   * @param revokedAt - Momento de la revocación.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await apiKeyService.markRevoked(manager, 'key-1', 'acc-1', new Date());
   * ```
   */
  async markRevoked(
    manager: EntityManager,
    apiKeyId: string,
    revokedByAccountId: string,
    revokedAt: Date,
  ): Promise<void> {
    await manager.getRepository(ApiKeyEntity).update(apiKeyId, {
      status: ApiKeyStatusEnum.REVOKED,
      revokedAt,
      revokedByAccountId,
    });
  }

  private repository(manager?: EntityManager): Repository<ApiKeyEntity> {
    return manager
      ? manager.getRepository(ApiKeyEntity)
      : this.apiKeyRepository;
  }
}

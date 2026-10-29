import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

// Entities
import { OrganizationPermissionEntity } from './entities/organization-permission.entity';
import { AccountPermissionEntity } from './entities/account-permission.entity';
import { AccountEntity } from 'src/account/entities/account.entity';

// Services
import { RolesService } from 'src/roles/roles.service';

// Enums
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

/**
 * Capacidades sobre el catálogo administrativo de permisos por organización y su asignación
 * directa a un miembro (`accounts.id`).
 *
 * Deliberadamente independiente del motor de RBAC (`RolesService`), del que sólo se reutiliza el
 * mecanismo "¿el llamador es ADMIN activo de esta organización?" para proteger estos endpoints
 * — ver `assertHasOrganizationPermission` en `AccountMemberService`/`AccountService`, duplicado
 * aquí por el mismo motivo que en esos dos servicios: cada uno resuelve la membresía del
 * llamador de forma distinta.
 *
 * Los flujos de cada endpoint viven en `applications/`; acá sólo están las piezas que comparten.
 */
@Injectable()
export class OrganizationPermissionsService {
  constructor(
    @InjectRepository(OrganizationPermissionEntity)
    private readonly organizationPermissionRepository: Repository<OrganizationPermissionEntity>,

    @InjectRepository(AccountPermissionEntity)
    private readonly accountPermissionRepository: Repository<AccountPermissionEntity>,

    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,

    @InjectDataSource()
    private readonly dataSource: DataSource,

    private readonly rolesService: RolesService,
  ) {}

  /** Catálogo de una organización, en el orden en que se fue creando. */
  async listForOrganization(
    organizationId: string,
  ): Promise<OrganizationPermissionEntity[]> {
    return this.organizationPermissionRepository.find({
      where: { organizationId },
      order: { createdAt: 'ASC' },
    });
  }

  /** Alta de un permiso en el catálogo de una organización. */
  async savePermission(
    organizationId: string,
    name: string,
  ): Promise<OrganizationPermissionEntity> {
    return this.organizationPermissionRepository.save(
      this.organizationPermissionRepository.create({ organizationId, name }),
    );
  }

  /** Escribe sólo los campos presentes: un `undefined` significa "no lo toques". */
  async updatePermission(
    permissionId: string,
    fields: { name?: string; isActive?: boolean },
  ): Promise<void> {
    await this.organizationPermissionRepository.update(permissionId, {
      ...(fields.name !== undefined && { name: fields.name }),
      ...(fields.isActive !== undefined && { isActive: fields.isActive }),
    });
  }

  async deletePermission(permissionId: string): Promise<void> {
    await this.organizationPermissionRepository.delete(permissionId);
  }

  /** Ids del catálogo que tiene asignados un miembro. */
  async findMemberPermissionIds(accountId: string): Promise<string[]> {
    const assignments = await this.accountPermissionRepository.find({
      where: { accountId },
    });

    return assignments.map((a) => a.organizationPermissionId);
  }

  /**
   * Reemplazo total y transaccional: borra las asignaciones actuales del miembro e inserta las
   * nuevas dentro de la misma transacción, para que "guardar" nunca deje al miembro con una
   * lista de permisos parcial si algo falla a medio camino.
   */
  async replaceMemberPermissions(
    accountId: string,
    permissionIds: string[],
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(AccountPermissionEntity);
      await repository.delete({ accountId });

      if (permissionIds.length > 0) {
        await repository.insert(
          permissionIds.map((organizationPermissionId) => ({
            accountId,
            organizationPermissionId,
          })),
        );
      }
    });
  }

  /**
   * Lanza BadRequestException si alguno de los ids no está en el catálogo de esa organización.
   *
   * Sin esta comprobación se podría asignar a un miembro un permiso de otra organización con
   * sólo conocer su id: la tabla de asignaciones no tiene forma de impedirlo por sí sola,
   * porque no guarda a qué organización pertenece cada lado.
   */
  async assertPermissionsBelongToOrganization(
    permissionIds: string[],
    organizationId: string,
  ): Promise<void> {
    if (permissionIds.length === 0) {
      return;
    }

    const matchingPermissions =
      await this.organizationPermissionRepository.find({
        where: { id: In(permissionIds), organizationId },
      });

    if (matchingPermissions.length !== permissionIds.length) {
      throw new BadRequestException(
        'Uno o más permisos no pertenecen al catálogo de esta organización',
      );
    }
  }

  /**
   * `organization_permissions` tiene un `@Unique(['organizationId', 'name'])` — sin este check
   * previo, un nombre repetido llega a violar la constraint en la base de datos y termina como
   * un 500 genérico (QueryFailedError sin capturar) en vez de un error claro para el usuario.
   */
  async assertNameNotTaken(
    organizationId: string,
    name: string,
  ): Promise<void> {
    const existing = await this.organizationPermissionRepository.findOne({
      where: { organizationId, name },
    });

    if (existing) {
      throw new ConflictException(
        `Ya existe un permiso con el nombre "${name}" en esta organización`,
      );
    }
  }

  /**
   * Resuelve un permiso exigiendo que pertenezca a esa organización. El `organizationId` es
   * parte de la búsqueda y no una comprobación posterior: así, pedir el permiso de otra
   * organización da 404 y no confirma que ese id exista en algún lado.
   */
  async findPermissionOrFail(
    organizationId: string,
    permissionId: string,
  ): Promise<OrganizationPermissionEntity> {
    const permission = await this.organizationPermissionRepository.findOne({
      where: { id: permissionId, organizationId },
    });

    if (!permission) {
      throw new NotFoundException(
        `Permiso con ID ${permissionId} no encontrado`,
      );
    }

    return permission;
  }

  /**
   * Resuelve una membresía de organización. Una cuenta personal (sin `organizationId`) se
   * trata como inexistente: no hay permisos de organización que asignarle.
   */
  async findMemberOrFail(accountId: string): Promise<AccountEntity> {
    const member = await this.accountRepository.findOne({
      where: { id: accountId },
    });

    if (!member || !member.organizationId) {
      throw new NotFoundException(
        `Membresía con ID ${accountId} no encontrada`,
      );
    }

    return member;
  }

  /**
   * Solo un miembro activo con permiso ORGANIZATION:{action} (rol ADMIN) puede gestionar el
   * catálogo de permisos o la asignación de un miembro — mismo criterio y mismo texto que
   * `AccountMemberService.assertHasOrganizationPermission`, duplicado aquí porque este servicio
   * resuelve la membresía del llamador de forma independiente.
   */
  async assertHasOrganizationPermission(
    callerId: string,
    organizationId: string,
    action: ACTION_KEY_ENUM,
  ): Promise<void> {
    const callerMembership = await this.accountRepository.findOne({
      where: { userId: callerId, organizationId, isActive: true },
      relations: { role: true },
    });

    await this.rolesService.assertHasPermission(
      callerMembership?.roleId,
      RESOURCE_KEY_ENUM.ORGANIZATION,
      action,
      'No tienes permisos de administrador sobre esta organización',
    );
  }
}

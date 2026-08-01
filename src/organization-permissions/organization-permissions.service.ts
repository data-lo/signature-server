import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

// Entities
import { OrganizationPermissionEntity } from './entities/organization-permission.entity';
import { AccountPermissionEntity } from './entities/account-permission.entity';
import { AccountEntity } from 'src/account/entities/account.entity';

// DTOs
import { CreateOrganizationPermissionDto } from './dto/create-organization-permission.dto';
import { UpdateOrganizationPermissionDto } from './dto/update-organization-permission.dto';

// Services
import { RolesService } from 'src/roles/roles.service';

// Enums
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

// Interfaces
import { BaseResponse } from 'src/interfaces/api-response.dto';
import {
  MemberPermissionsData,
  OrganizationPermissionData,
} from './interfaces/response/organization-permission-response';

/**
 * Catálogo administrativo de permisos por organización + su asignación directa a un miembro
 * (`accounts.id`). Deliberadamente independiente del motor de RBAC (`RolesService`), del que
 * solo se reutiliza el mecanismo "¿el llamador es ADMIN activo de esta organización?" para
 * proteger estos endpoints — ver `assertHasOrganizationPermission` en
 * `AccountMemberService`/`AccountService`, duplicado aquí por el mismo motivo que en esos dos
 * servicios: cada uno resuelve la membresía del llamador de forma distinta.
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

  async findAllForOrganization(
    callerId: string,
    organizationId: string,
  ): Promise<BaseResponse<OrganizationPermissionData[]>> {
    await this.assertHasOrganizationPermission(
      callerId,
      organizationId,
      ACTION_KEY_ENUM.READ,
    );

    const permissions = await this.organizationPermissionRepository.find({
      where: { organizationId },
      order: { createdAt: 'ASC' },
    });

    return {
      success: true,
      message: 'Permisos obtenidos correctamente',
      data: permissions,
    };
  }

  async create(
    callerId: string,
    organizationId: string,
    dto: CreateOrganizationPermissionDto,
  ): Promise<BaseResponse<OrganizationPermissionData>> {
    await this.assertHasOrganizationPermission(
      callerId,
      organizationId,
      ACTION_KEY_ENUM.CREATE,
    );

    const permission = await this.organizationPermissionRepository.save(
      this.organizationPermissionRepository.create({
        organizationId,
        name: dto.name,
      }),
    );

    return {
      success: true,
      message: 'Permiso creado correctamente',
      data: permission,
    };
  }

  async update(
    callerId: string,
    organizationId: string,
    permissionId: string,
    dto: UpdateOrganizationPermissionDto,
  ): Promise<BaseResponse<OrganizationPermissionData>> {
    await this.assertHasOrganizationPermission(
      callerId,
      organizationId,
      ACTION_KEY_ENUM.UPDATE,
    );

    const permission = await this.findPermissionOrFail(
      organizationId,
      permissionId,
    );

    await this.organizationPermissionRepository.update(permission.id, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
    });

    return {
      success: true,
      message: 'Permiso actualizado correctamente',
      data: await this.findPermissionOrFail(organizationId, permissionId),
    };
  }

  async remove(
    callerId: string,
    organizationId: string,
    permissionId: string,
  ): Promise<BaseResponse> {
    await this.assertHasOrganizationPermission(
      callerId,
      organizationId,
      ACTION_KEY_ENUM.DELETE,
    );

    await this.findPermissionOrFail(organizationId, permissionId);
    await this.organizationPermissionRepository.delete(permissionId);

    return {
      success: true,
      message: 'Permiso eliminado correctamente',
    };
  }

  async findMemberPermissions(
    callerId: string,
    accountId: string,
  ): Promise<BaseResponse<MemberPermissionsData>> {
    const member = await this.findMemberOrFail(accountId);
    await this.assertHasOrganizationPermission(
      callerId,
      member.organizationId as string,
      ACTION_KEY_ENUM.READ,
    );

    const assignments = await this.accountPermissionRepository.find({
      where: { accountId },
    });

    return {
      success: true,
      message: 'Permisos del miembro obtenidos correctamente',
      data: {
        accountId,
        permissionIds: assignments.map((a) => a.organizationPermissionId),
      },
    };
  }

  /**
   * Reemplazo total y transaccional: borra las asignaciones actuales del miembro e inserta las
   * nuevas dentro de la misma transacción, para que "guardar" nunca deje al miembro con una
   * lista de permisos parcial si algo falla a medio camino.
   */
  async assignToMember(
    callerId: string,
    accountId: string,
    permissionIds: string[],
  ): Promise<BaseResponse<MemberPermissionsData>> {
    const member = await this.findMemberOrFail(accountId);
    const organizationId = member.organizationId as string;
    await this.assertHasOrganizationPermission(
      callerId,
      organizationId,
      ACTION_KEY_ENUM.UPDATE,
    );

    const uniquePermissionIds = Array.from(new Set(permissionIds));
    if (uniquePermissionIds.length > 0) {
      const matchingPermissions =
        await this.organizationPermissionRepository.find({
          where: { id: In(uniquePermissionIds), organizationId },
        });
      if (matchingPermissions.length !== uniquePermissionIds.length) {
        throw new BadRequestException(
          'Uno o más permisos no pertenecen al catálogo de esta organización',
        );
      }
    }

    await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(AccountPermissionEntity);
      await repository.delete({ accountId });
      if (uniquePermissionIds.length > 0) {
        await repository.insert(
          uniquePermissionIds.map((organizationPermissionId) => ({
            accountId,
            organizationPermissionId,
          })),
        );
      }
    });

    return {
      success: true,
      message: 'Permisos del miembro actualizados correctamente',
      data: { accountId, permissionIds: uniquePermissionIds },
    };
  }

  private async findPermissionOrFail(
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

  private async findMemberOrFail(accountId: string): Promise<AccountEntity> {
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
  private async assertHasOrganizationPermission(
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

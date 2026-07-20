// External dependencies
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

// DTOs
import { CreateAccountMemberDto } from './dto/create-account-member.dto';
import { UpdateAccountMemberDto } from './dto/update-account-member.dto';

// Entities
import { AccountEntity } from './entities/account.entity';
import { UserEntity } from 'src/user/entities/user.entity';

// Services
import { AccountService } from './account.service';
import { RolesService } from 'src/roles/roles.service';

// Enums
import { ACCOUNT_TYPE_ENUM } from './enums/account-type.enum';
import { ACCOUNT_STATUS_ENUM } from './enums/account-status.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';

// Interfaces
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { OrganizationMemberData } from './interfaces/response/account-member-response';

/**
 * Gestiona membresías de organización — desde la fusión Account/AccountMember (ver plan de
 * migración ER-V2, Fase 5) esto ya no es una entidad separada: una "membresía" es una fila más
 * de `accounts`, filtrada por `organizationId`. Este servicio queda enfocado en el flujo de
 * gestión explícita de acceso (otorgar/listar/actualizar/revocar), separado del flujo
 * transaccional de creación (`AccountService.createOrganization`/`createDefaultPersonalAccount`).
 */
@Injectable()
export class AccountMemberService {
  constructor(
    @InjectRepository(AccountEntity)
    private accountRepository: Repository<AccountEntity>,

    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,

    private readonly accountService: AccountService,
    private readonly rolesService: RolesService,
  ) {}

  async create(
    callerId: string,
    dto: CreateAccountMemberDto,
  ): Promise<BaseResponse<AccountEntity>> {
    await this.assertHasOrganizationPermission(
      callerId,
      dto.organizationId,
      ACTION_KEY_ENUM.CREATE,
    );
    await this.rolesService.findByIdOrFail(dto.roleId);

    const existingMembership = await this.accountRepository.findOne({
      where: { organizationId: dto.organizationId, userId: dto.userId },
    });
    if (existingMembership) {
      throw new ConflictException(
        'El usuario ya tiene acceso a esta organización',
      );
    }

    const invitedUser = await this.userRepository.findOne({
      where: { id: dto.userId },
    });
    if (!invitedUser) {
      throw new NotFoundException(`Usuario con ID ${dto.userId} no encontrado`);
    }

    const member = this.accountRepository.create({
      userId: dto.userId,
      accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
      organizationId: dto.organizationId,
      roleId: dto.roleId,
      position: dto.position ?? null,
      isActive: dto.isActive ?? true,
      status:
        (dto.isActive ?? true)
          ? ACCOUNT_STATUS_ENUM.ACTIVE
          : ACCOUNT_STATUS_ENUM.SUSPENDED,
      email: invitedUser.email,
      password: invitedUser.password,
      joinedAt: new Date(),
    });

    const newMember = await this.accountRepository.save(member);

    return {
      success: true,
      message: 'Acceso otorgado correctamente',
      data: newMember,
    };
  }

  async findByOrganization(
    callerId: string,
    organizationId: string,
  ): Promise<BaseResponse<AccountEntity[]>> {
    await this.assertHasOrganizationPermission(
      callerId,
      organizationId,
      ACTION_KEY_ENUM.READ,
    );

    const members = await this.accountRepository.find({
      where: { organizationId, isActive: true },
    });

    return {
      success: true,
      message: 'Miembros obtenidos correctamente',
      data: members,
    };
  }

  /**
   * Shape delgado para la sección de gestión de miembros (ver historia [STORY] Gestión de
   * Miembros: Listado, Edición de Roles y Eliminación en Organización) — email/rfc/rol/fecha de
   * ingreso, en vez de la AccountEntity completa. `email` ya vive en `accounts` (sincronizado
   * desde la credencial única del usuario, decisión D6 del plan ER-V2) así que no hace falta
   * tocar `users` para eso; `rfc` sí requiere el join `accounts -> users -> personal_information`
   * porque solo vive ahí. Solo devuelve miembros activos — un miembro eliminado (soft-delete) no
   * debe reaparecer en la tabla de gestión.
   */
  async findMembersForOrganizationDetailed(
    callerId: string,
    organizationId: string,
  ): Promise<BaseResponse<OrganizationMemberData[]>> {
    await this.assertHasOrganizationPermission(
      callerId,
      organizationId,
      ACTION_KEY_ENUM.READ,
    );

    const members = await this.accountRepository.find({
      where: { organizationId, isActive: true },
      relations: { user: { personalInformation: true }, role: true },
      order: { joinedAt: 'ASC' },
    });

    return {
      success: true,
      message: 'Miembros obtenidos correctamente',
      data: members.map((member) => ({
        accountId: member.id,
        userId: member.userId,
        email: member.email,
        rfc: member.user?.personalInformation?.rfc ?? null,
        role: member.role
          ? { id: member.role.id, name: member.role.name }
          : null,
        joinedAt: member.joinedAt,
      })),
    };
  }

  async findOne(
    callerId: string,
    id: string,
  ): Promise<BaseResponse<AccountEntity>> {
    const member = await this.findEntityById(id);
    if (!member.organizationId) {
      throw new NotFoundException(`Membresía con ID ${id} no encontrada`);
    }
    await this.assertHasOrganizationPermission(
      callerId,
      member.organizationId,
      ACTION_KEY_ENUM.READ,
    );

    return {
      success: true,
      message: 'Miembro obtenido correctamente',
      data: member,
    };
  }

  async update(
    callerId: string,
    id: string,
    updateAccountMemberDto: UpdateAccountMemberDto,
  ): Promise<BaseResponse<AccountEntity>> {
    const member = await this.findEntityById(id);
    if (!member.organizationId) {
      throw new NotFoundException(`Membresía con ID ${id} no encontrada`);
    }
    await this.assertHasOrganizationPermission(
      callerId,
      member.organizationId,
      ACTION_KEY_ENUM.UPDATE,
    );

    const changesRole =
      updateAccountMemberDto.roleId !== undefined &&
      updateAccountMemberDto.roleId !== member.roleId;
    const deactivates = updateAccountMemberDto.isActive === false;
    if (changesRole || deactivates) {
      await this.assertNotLastAdmin(member.organizationId, member);
    }

    if (updateAccountMemberDto.roleId) {
      await this.rolesService.findByIdOrFail(updateAccountMemberDto.roleId);
    }

    await this.accountRepository.update(id, {
      ...(updateAccountMemberDto.roleId && {
        roleId: updateAccountMemberDto.roleId,
      }),
      ...(updateAccountMemberDto.position !== undefined && {
        position: updateAccountMemberDto.position,
      }),
      ...(updateAccountMemberDto.isActive !== undefined && {
        isActive: updateAccountMemberDto.isActive,
        status: updateAccountMemberDto.isActive
          ? ACCOUNT_STATUS_ENUM.ACTIVE
          : ACCOUNT_STATUS_ENUM.SUSPENDED,
      }),
    });

    return {
      success: true,
      message: 'Membresía actualizada correctamente',
      data: await this.findEntityById(id),
    };
  }

  async remove(callerId: string, id: string): Promise<BaseResponse> {
    const membership = await this.accountRepository.findOne({
      where: { id, isActive: true },
    });
    if (!membership || !membership.organizationId) {
      throw new NotFoundException(`Membresía con ID ${id} no encontrada`);
    }
    await this.assertHasOrganizationPermission(
      callerId,
      membership.organizationId,
      ACTION_KEY_ENUM.DELETE,
    );

    await this.assertNotLastAdmin(membership.organizationId, membership);

    await this.accountRepository.update(id, {
      isActive: false,
      status: ACCOUNT_STATUS_ENUM.REMOVED,
      leftAt: new Date(),
    });

    await this.accountService.removeAccountFromCatalog(
      membership.userId,
      membership.id,
    );

    return {
      success: true,
      message: 'Acceso revocado correctamente',
    };
  }

  private async findEntityById(id: string): Promise<AccountEntity> {
    const member = await this.accountRepository.findOne({
      where: { id },
    });

    if (!member) {
      throw new NotFoundException(`Membresía con ID ${id} no encontrada`);
    }

    return member;
  }

  /**
   * Solo un miembro activo con permiso ORGANIZATION:{action} puede otorgar/listar/actualizar/
   * revocar membresías. Permiso granular vía `RolesService.hasPermission` en vez de comparar
   * `role.name === 'ADMIN'` a mano — mismo criterio que `AccountService`
   * (`assertHasOrganizationPermission`), duplicado aquí porque este servicio resuelve la
   * membresía del llamador por `organizationId`, no por `accountId` propio.
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

  /**
   * Protección del último administrador (ver historia [STORY] Gestión de Miembros, sección
   * "Reglas de Negocio y Seguridad"): si `target` es hoy el único miembro ADMIN activo de la
   * organización, ni degradar su rol ni desactivar su acceso está permitido — dejaría la
   * organización sin nadie que pueda gestionarla. Se aplica sin importar si el llamador es el
   * propio `target` u otro ADMIN, porque el riesgo es el mismo en ambos casos (el sistema no
   * tiene un rol OWNER separado de ADMIN, así que "el último dueño" se traduce aquí como "el
   * último ADMIN"). No-op si `target` no es ADMIN hoy (nada que proteger).
   */
  private async assertNotLastAdmin(
    organizationId: string,
    target: AccountEntity,
  ): Promise<void> {
    const adminRole = await this.rolesService.findSystemRoleByName(
      SYSTEM_ROLE_NAME_ENUM.ADMIN,
    );
    if (target.roleId !== adminRole.id) {
      return;
    }

    const activeAdminCount = await this.accountRepository.count({
      where: { organizationId, isActive: true, roleId: adminRole.id },
    });

    if (activeAdminCount <= 1) {
      throw new ConflictException(
        'No puedes cambiar el rol ni eliminar al único administrador activo de la organización',
      );
    }
  }

  /**
   * Check de tenant más laxo que assertHasOrganizationPermission: cualquier miembro activo de la
   * cuenta (sin importar su rol) puede operar dentro de ese contexto — usado por módulos donde
   * pertenecer a la cuenta basta (p. ej. crear o listar documentos scopeados por la cuenta
   * activa), a diferencia de gestionar la membresía misma, que sigue siendo solo-ADMIN.
   * Retorna la cuenta resuelta para que el llamador (p. ej. DocumentService) no tenga que
   * volver a consultarla para saber su organizationId.
   */
  async assertIsActiveMember(
    userId: string,
    accountId: string,
  ): Promise<AccountEntity> {
    const membership = await this.accountRepository.findOne({
      where: { id: accountId, userId, isActive: true },
    });

    if (!membership) {
      throw new ForbiddenException('No perteneces a esta cuenta');
    }

    return membership;
  }
}

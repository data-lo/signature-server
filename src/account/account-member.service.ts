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
import { RolesService } from 'src/roles/roles.service';

// Enums
import { ACCOUNT_TYPE_ENUM } from './enums/account-type.enum';
import { ACCOUNT_STATUS_ENUM } from './enums/account-status.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';

// Interfaces
import { OrganizationMemberData } from './interfaces/response/account-member-response';

/**
 * Gestiona membresías de organización — desde la fusión Account/AccountMember (ver plan de
 * migración ER-V2, Fase 5) esto ya no es una entidad separada: una "membresía" es una fila más
 * de `accounts`, filtrada por `organizationId`. Este servicio queda enfocado en el flujo de
 * gestión explícita de acceso (otorgar/listar/actualizar/revocar), separado del flujo
 * transaccional de creación (`AccountService.saveOrganizationWithAdminAccount`/
 * `createDefaultPersonalAccount`).
 *
 * Los flujos de cada endpoint viven en `applications/`; acá sólo están las piezas que comparten.
 */
@Injectable()
export class AccountMemberService {
  constructor(
    @InjectRepository(AccountEntity)
    private accountRepository: Repository<AccountEntity>,

    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,

    private readonly rolesService: RolesService,
  ) {}

  /**
   * Resuelve la cuenta PERSONAL (1:1 con el usuario) de un usuario dado — usada donde un
   * recurso necesita anclarse a "esta persona" sin la ambigüedad de "cuál membresía" (ver
   * `CollaboratorEntity.accountId`, ER-V2). Mismo patrón que ya usaban `seed-documents.ts` y
   * varias migraciones para backfill, centralizado acá para no duplicarlo.
   */
  async findPersonalAccountId(userId: string): Promise<string> {
    const personalAccount = await this.accountRepository.findOne({
      where: { userId, accountType: ACCOUNT_TYPE_ENUM.PERSONAL },
    });

    if (!personalAccount) {
      throw new NotFoundException(
        `No se encontró una cuenta PERSONAL para el usuario ${userId}`,
      );
    }

    return personalAccount.id;
  }

  /**
   * Membresía existente de un usuario en una organización, activa o no. Se mira sin filtrar
   * por `isActive` a propósito: quien ya estuvo y fue dado de baja tiene fila, y volver a
   * insertarla dejaría dos membresías del mismo usuario en la misma organización.
   */
  async findExistingMembership(
    organizationId: string,
    userId: string,
  ): Promise<AccountEntity | null> {
    return this.accountRepository.findOne({
      where: { organizationId, userId },
    });
  }

  /** Usuario por id, exigiendo que exista. */
  async findUserOrFail(userId: string): Promise<UserEntity> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException(`Usuario con ID ${userId} no encontrado`);
    }

    return user;
  }

  /**
   * Alta de una fila de membresía. `email`/`password` se copian del invitado porque son la
   * credencial única sincronizada (decisión D6): el login resuelve contra `accounts`, así que
   * una membresía sin ellos no serviría para entrar en ese contexto.
   *
   * `status` se deriva de `isActive` en vez de recibirse: son dos formas de decir lo mismo y
   * dejarlas entrar por separado permitiría guardar una membresía activa marcada como
   * suspendida.
   */
  async saveMembership(
    dto: CreateAccountMemberDto,
    invitedUser: UserEntity,
  ): Promise<AccountEntity> {
    const isActive = dto.isActive ?? true;

    return this.accountRepository.save(
      this.accountRepository.create({
        userId: dto.userId,
        accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
        organizationId: dto.organizationId,
        roleId: dto.roleId,
        position: dto.position ?? null,
        isActive,
        status: isActive
          ? ACCOUNT_STATUS_ENUM.ACTIVE
          : ACCOUNT_STATUS_ENUM.SUSPENDED,
        email: invitedUser.email,
        password: invitedUser.password,
        joinedAt: new Date(),
      }),
    );
  }

  /** Miembros activos de una organización, como filas de `accounts`. */
  async listActiveByOrganization(
    organizationId: string,
  ): Promise<AccountEntity[]> {
    return this.accountRepository.find({
      where: { organizationId, isActive: true },
    });
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
  /**
   * Shape delgado para la sección de gestión de miembros (ver historia [STORY] Gestión de
   * Miembros: Listado, Edición de Roles y Eliminación en Organización) — email/rfc/rol/fecha de
   * ingreso, en vez de la AccountEntity completa. `email` ya vive en `accounts` (sincronizado
   * desde la credencial única del usuario, decisión D6 del plan ER-V2) así que no hace falta
   * tocar `users` para eso; `rfc` sí requiere el join `accounts -> users -> personal_information`
   * porque solo vive ahí. Solo devuelve miembros activos — un miembro eliminado (soft-delete) no
   * debe reaparecer en la tabla de gestión.
   */
  async listDetailedByOrganization(
    organizationId: string,
  ): Promise<OrganizationMemberData[]> {
    const members = await this.accountRepository.find({
      where: { organizationId, isActive: true },
      relations: { user: { personalInformation: true }, role: true },
      order: { joinedAt: 'ASC' },
    });

    return members.map((member) => ({
      accountId: member.id,
      userId: member.userId,
      email: member.email,
      rfc: member.user?.personalInformation?.rfc ?? null,
      role: member.role ? { id: member.role.id, name: member.role.name } : null,
      joinedAt: member.joinedAt,
    }));
  }

  /** Escribe sólo los campos presentes; `status` se mantiene coherente con `isActive`. */
  async applyMembershipUpdate(
    id: string,
    dto: UpdateAccountMemberDto,
  ): Promise<void> {
    await this.accountRepository.update(id, {
      ...(dto.roleId && { roleId: dto.roleId }),
      ...(dto.position !== undefined && { position: dto.position }),
      ...(dto.isActive !== undefined && {
        isActive: dto.isActive,
        status: dto.isActive
          ? ACCOUNT_STATUS_ENUM.ACTIVE
          : ACCOUNT_STATUS_ENUM.SUSPENDED,
      }),
    });
  }

  /**
   * Baja lógica de una membresía. La fila se conserva porque su id quedó referenciado desde
   * los documentos que ese miembro creó o firmó dentro de la organización.
   */
  async markMembershipRemoved(id: string): Promise<void> {
    await this.accountRepository.update(id, {
      isActive: false,
      status: ACCOUNT_STATUS_ENUM.REMOVED,
      leftAt: new Date(),
    });
  }

  /** Membresía activa por id, exigiendo que exista y que siga activa. */
  async findActiveMembershipOrFail(id: string): Promise<AccountEntity> {
    const membership = await this.accountRepository.findOne({
      where: { id, isActive: true },
    });

    if (!membership || !membership.organizationId) {
      throw new NotFoundException(`Membresía con ID ${id} no encontrada`);
    }

    return membership;
  }

  /**
   * Membresía de organización por id. Una cuenta personal se trata como inexistente: no es una
   * membresía y no se gestiona por estos endpoints.
   */
  async findMembershipOrFail(id: string): Promise<AccountEntity> {
    const member = await this.findByIdOrFail(id);

    if (!member.organizationId) {
      throw new NotFoundException(`Membresía con ID ${id} no encontrada`);
    }

    return member;
  }

  async findByIdOrFail(id: string): Promise<AccountEntity> {
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

  /**
   * Protección del último administrador (ver historia [STORY] Gestión de Miembros, sección
   * "Reglas de Negocio y Seguridad"): si `target` es hoy el único miembro ADMIN activo de la
   * organización, ni degradar su rol ni desactivar su acceso está permitido — dejaría la
   * organización sin nadie que pueda gestionarla. Se aplica sin importar si el llamador es el
   * propio `target` u otro ADMIN, porque el riesgo es el mismo en ambos casos (el sistema no
   * tiene un rol OWNER separado de ADMIN, así que "el último dueño" se traduce aquí como "el
   * último ADMIN"). No-op si `target` no es ADMIN hoy (nada que proteger).
   */
  async assertNotLastAdmin(
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

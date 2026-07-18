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
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';

// Interfaces
import { BaseResponse } from 'src/interfaces/api-response.dto';

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
    await this.assertIsOrganizationAdmin(callerId, dto.organizationId);
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
    await this.assertIsOrganizationAdmin(callerId, organizationId);

    const members = await this.accountRepository.find({
      where: { organizationId },
    });

    return {
      success: true,
      message: 'Miembros obtenidos correctamente',
      data: members,
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
    await this.assertIsOrganizationAdmin(callerId, member.organizationId);

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
    await this.assertIsOrganizationAdmin(callerId, member.organizationId);

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
    await this.assertIsOrganizationAdmin(callerId, membership.organizationId);

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
   * Solo un miembro activo con rol ADMIN de esa organización puede otorgar/listar/actualizar/
   * revocar membresías. Lanza ForbiddenException si el llamador no lo es.
   */
  private async assertIsOrganizationAdmin(
    callerId: string,
    organizationId: string,
  ): Promise<void> {
    const callerMembership = await this.accountRepository.findOne({
      where: { userId: callerId, organizationId, isActive: true },
      relations: { role: true },
    });

    if (callerMembership?.role?.name !== SYSTEM_ROLE_NAME_ENUM.ADMIN) {
      throw new ForbiddenException(
        'No tienes permisos de administrador sobre esta organización',
      );
    }
  }

  /**
   * Check de tenant más laxo que assertIsOrganizationAdmin: cualquier miembro activo de la
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

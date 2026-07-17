// External dependencies
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

// DTOs
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { InviteMemberDto } from './dto/invite-member.dto';

// Entities
import { AccountEntity } from './entities/account.entity';
import { OrganizationDetailEntity } from './entities/organization-detail.entity';
import { AccountMemberEntity } from './entities/account-member.entity';

// Enums
import { ACCOUNT_TYPE_ENUM } from './enums/account-type.enum';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';

// Services
import { RolesService } from 'src/roles/roles.service';

// Interfaces
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { RedisService } from 'src/shared/redis/redis.service';
import { AccountData } from './interfaces/response/account-response';

const ACCOUNTS_CATALOG_KEY_PREFIX = 'accounts:';

/** Campos de la membresía del usuario que se cachean junto a la cuenta. */
interface MembershipCatalogFields {
  roleId: string | null;
  isActive: boolean;
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @InjectRepository(AccountEntity)
    private accountRepository: Repository<AccountEntity>,

    @InjectRepository(OrganizationDetailEntity)
    private organizationDetailRepository: Repository<OrganizationDetailEntity>,

    @InjectRepository(AccountMemberEntity)
    private accountMemberRepository: Repository<AccountMemberEntity>,

    @InjectDataSource()
    private dataSource: DataSource,

    private redisService: RedisService,
    private rolesService: RolesService,
  ) {}

  async create(
    createAccountDto: CreateAccountDto,
  ): Promise<BaseResponse<AccountEntity>> {
    const account = this.accountRepository.create({
      name: createAccountDto.name,
      type: createAccountDto.type,
    });

    const newAccount = await this.accountRepository.save(account);

    if (newAccount.type === ACCOUNT_TYPE_ENUM.ORGANIZATION) {
      const organizationDetail = this.organizationDetailRepository.create({
        accountId: newAccount.id,
        name: createAccountDto.organizationName,
      });
      await this.organizationDetailRepository.save(organizationDetail);
    }

    return {
      success: true,
      message: 'Cuenta creada correctamente',
      data: await this.findEntityById(newAccount.id),
    };
  }

  async findAll(): Promise<BaseResponse<AccountEntity[]>> {
    const accounts = await this.accountRepository.find({
      relations: { organizationDetail: true },
    });

    return {
      success: true,
      message: 'Cuentas obtenidas correctamente',
      data: accounts,
    };
  }

  async findOne(
    callerId: string,
    id: string,
  ): Promise<BaseResponse<AccountEntity>> {
    await this.assertIsAccountAdmin(callerId, id);
    const account = await this.findEntityById(id);

    return {
      success: true,
      message: 'Cuenta obtenida correctamente',
      data: account,
    };
  }

  async update(
    callerId: string,
    id: string,
    updateAccountDto: UpdateAccountDto,
  ): Promise<BaseResponse<AccountEntity>> {
    await this.assertIsAccountAdmin(callerId, id);
    const account = await this.findEntityById(id);

    await this.accountRepository.update(id, {
      ...(updateAccountDto.name && { name: updateAccountDto.name }),
    });

    if (
      account.type === ACCOUNT_TYPE_ENUM.ORGANIZATION &&
      updateAccountDto.organizationName
    ) {
      await this.organizationDetailRepository.update(id, {
        name: updateAccountDto.organizationName,
      });
    }

    const updatedAccount = await this.findEntityById(id);

    if (updateAccountDto.name || updateAccountDto.organizationName) {
      await this.refreshCatalogForAccountMembers(updatedAccount);
    }

    return {
      success: true,
      message: 'Cuenta actualizada correctamente',
      data: updatedAccount,
    };
  }

  private async findEntityById(id: string): Promise<AccountEntity> {
    const account = await this.accountRepository.findOne({
      where: { id },
      relations: { organizationDetail: true },
    });

    if (!account) {
      throw new NotFoundException(`Cuenta con ID ${id} no encontrada`);
    }

    return account;
  }

  /**
   * Solo un miembro activo con rol ADMIN puede leer o actualizar la cuenta.
   * Lanza ForbiddenException si el llamador no lo es.
   */
  private async assertIsAccountAdmin(
    callerId: string,
    accountId: string,
  ): Promise<void> {
    const callerMembership = await this.accountMemberRepository.findOne({
      where: { userId: callerId, accountId, isActive: true },
      relations: { role: true },
    });

    if (callerMembership?.role?.name !== SYSTEM_ROLE_NAME_ENUM.ADMIN) {
      throw new ForbiddenException(
        'No tienes permisos de administrador sobre esta cuenta',
      );
    }
  }

  /**
   * Crea la cuenta PERSONAL por defecto de un usuario recién registrado y su
   * membresía con el rol de sistema ADMIN. Recibe el EntityManager del
   * llamador para poder enlistarse en la transacción de registro (no abre su
   * propia transacción). Retorna también la membresía creada para que el
   * llamador pueda cachearla en el catálogo de Redis sin duplicar el
   * conocimiento de qué roleId/isActive le corresponde a la cuenta personal.
   */
  async createDefaultPersonalAccount(
    manager: EntityManager,
    userId: string,
    accountName: string,
  ): Promise<{ account: AccountEntity; membership: AccountMemberEntity }> {
    const account = await manager.save(
      manager.create(AccountEntity, {
        name: accountName,
        type: ACCOUNT_TYPE_ENUM.PERSONAL,
      }),
    );

    const adminRole = await this.rolesService.findSystemRoleByName(
      SYSTEM_ROLE_NAME_ENUM.ADMIN,
    );

    const membership = await manager.save(
      manager.create(AccountMemberEntity, {
        accountId: account.id,
        userId,
        roleId: adminRole.id,
        isActive: true,
      }),
    );

    return { account, membership };
  }

  /**
   * Crea una Organización de forma transaccional: Account(type=ORGANIZATION),
   * OrganizationDetail, y la membresía del usuario autenticado con el rol de
   * sistema ADMIN (el creador de una organización queda como su administrador
   * de inmediato, igual que en la cuenta personal). Al confirmar, refresca el
   * catálogo de cuentas cacheado en Redis.
   */
  async createOrganization(
    userId: string,
    dto: CreateOrganizationDto,
  ): Promise<BaseResponse<AccountData>> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const account = await queryRunner.manager.save(
        queryRunner.manager.create(AccountEntity, {
          name: dto.name,
          type: ACCOUNT_TYPE_ENUM.ORGANIZATION,
        }),
      );

      await queryRunner.manager.save(
        queryRunner.manager.create(OrganizationDetailEntity, {
          accountId: account.id,
          name: dto.organizationName,
        }),
      );

      const adminRole = await this.rolesService.findSystemRoleByName(
        SYSTEM_ROLE_NAME_ENUM.ADMIN,
      );

      const membership = await queryRunner.manager.save(
        queryRunner.manager.create(AccountMemberEntity, {
          accountId: account.id,
          userId,
          roleId: adminRole.id,
          isActive: true,
        }),
      );

      await queryRunner.commitTransaction();

      const fullAccount = await this.findEntityById(account.id);
      const membershipFields: MembershipCatalogFields = {
        roleId: membership.roleId,
        isActive: membership.isActive,
      };
      await this.appendAccountToCatalog(userId, fullAccount, membershipFields);

      return {
        success: true,
        message: 'Organización creada correctamente',
        // toCatalogEntry (no la AccountEntity cruda) para que la respuesta
        // HTTP incluya role/isActive, igual que el catálogo cacheado.
        data: this.toCatalogEntry(fullAccount, membershipFields),
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Invitar a un nuevo miembro a la organización activa — alcance delimitado
   * a propósito (ver historia [STORY] Módulo de Invitación de Miembros):
   * valida el payload, que el llamador sea ADMIN de esa cuenta y que el
   * roleId exista, y responde éxito. No envía correo, no genera token de
   * invitación, ni inserta ninguna membresía/entrada de catálogo todavía —
   * eso es explícitamente una siguiente iteración.
   */
  async inviteMember(
    callerId: string,
    accountId: string,
    dto: InviteMemberDto,
  ): Promise<BaseResponse<null>> {
    if (!accountId) {
      throw new BadRequestException(
        'Falta el header X-Account-Id de la organización activa',
      );
    }

    await this.assertIsAccountAdmin(callerId, accountId);

    const account = await this.findEntityById(accountId);
    if (account.type !== ACCOUNT_TYPE_ENUM.ORGANIZATION) {
      throw new BadRequestException(
        'Solo se pueden invitar miembros a una cuenta de tipo ORGANIZATION',
      );
    }

    await this.rolesService.findByIdOrFail(dto.roleId);

    return {
      success: true,
      message: 'Invitación registrada correctamente',
      data: null,
    };
  }

  /**
   * Agrega una cuenta al catálogo cacheado en Redis DB 0 bajo la key
   * accounts:{userId} (lectura-modificación-escritura). Un fallo de Redis
   * nunca debe tumbar la operación que lo dispara.
   */
  async appendAccountToCatalog(
    userId: string,
    account: AccountEntity,
    membership: MembershipCatalogFields,
  ): Promise<void> {
    try {
      const key = ACCOUNTS_CATALOG_KEY_PREFIX + userId;
      const existingRaw = await this.redisService.get(key);
      const catalog: AccountData[] = existingRaw ? JSON.parse(existingRaw) : [];

      catalog.push(this.toCatalogEntry(account, membership));

      await this.redisService.set(key, JSON.stringify(catalog));
    } catch (error) {
      this.logger.warn(
        `No se pudo refrescar el catálogo de cuentas en Redis para el usuario ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Refresca la entrada de esta cuenta dentro del catálogo cacheado en Redis
   * de cada miembro activo. Se usa tras renombrar una cuenta/organización
   * (`update()`) para que el switcher del frontend no muestre un nombre
   * obsoleto indefinidamente.
   */
  private async refreshCatalogForAccountMembers(
    account: AccountEntity,
  ): Promise<void> {
    const members = await this.accountMemberRepository.find({
      where: { accountId: account.id, isActive: true },
    });

    await Promise.all(
      members.map((member) =>
        this.replaceAccountInCatalog(member.userId, account),
      ),
    );
  }

  private async replaceAccountInCatalog(
    userId: string,
    account: AccountEntity,
  ): Promise<void> {
    try {
      const key = ACCOUNTS_CATALOG_KEY_PREFIX + userId;
      const existingRaw = await this.redisService.get(key);
      if (!existingRaw) {
        return;
      }

      const catalog: AccountData[] = JSON.parse(existingRaw);
      const index = catalog.findIndex((entry) => entry.id === account.id);
      if (index === -1) {
        return;
      }

      // Renombrar una cuenta no toca la membresía: se preserva el roleId/isActive
      // ya cacheado en vez de requerir una consulta extra a account_members.
      catalog[index] = this.toCatalogEntry(account, {
        roleId: catalog[index].roleId,
        isActive: catalog[index].isActive,
      });
      await this.redisService.set(key, JSON.stringify(catalog));
    } catch (error) {
      this.logger.warn(
        `No se pudo refrescar el catálogo de cuentas en Redis para el usuario ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Quita una cuenta del catálogo cacheado en Redis del usuario. Se usa al
   * revocar el acceso de un miembro (`AccountMemberService.remove`), para que
   * el switcher del frontend no siga ofreciendo una cuenta a la que el
   * usuario ya no tiene acceso.
   */
  async removeAccountFromCatalog(
    userId: string,
    accountId: string,
  ): Promise<void> {
    try {
      const key = ACCOUNTS_CATALOG_KEY_PREFIX + userId;
      const existingRaw = await this.redisService.get(key);
      if (!existingRaw) {
        return;
      }

      const catalog: AccountData[] = JSON.parse(existingRaw);
      const filtered = catalog.filter((entry) => entry.id !== accountId);
      if (filtered.length === catalog.length) {
        return;
      }

      await this.redisService.set(key, JSON.stringify(filtered));
    } catch (error) {
      this.logger.warn(
        `No se pudo actualizar el catálogo de cuentas en Redis para el usuario ${userId} al revocar la cuenta ${accountId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Lee el catálogo de cuentas del usuario autenticado exclusivamente desde
   * Redis DB 0 (sin fallback a PostgreSQL). Si la key no existe, retorna un
   * catálogo vacío.
   */
  async getAccountsCatalog(
    userId: string,
  ): Promise<BaseResponse<AccountData[]>> {
    const raw = await this.redisService.get(
      ACCOUNTS_CATALOG_KEY_PREFIX + userId,
    );
    const catalog: AccountData[] = raw ? JSON.parse(raw) : [];

    return {
      success: true,
      message: 'Cuentas obtenidas correctamente',
      data: catalog,
    };
  }

  private toCatalogEntry(
    account: AccountEntity,
    membership: MembershipCatalogFields,
  ): AccountData {
    return {
      id: account.id,
      name: account.name,
      type: account.type,
      createdAt: account.createdAt,
      organizationDetail: account.organizationDetail
        ? { name: account.organizationDetail.name }
        : null,
      roleId: membership.roleId,
      isActive: membership.isActive,
    };
  }
}

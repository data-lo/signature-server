// External dependencies
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

// DTOs
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';

// Entities
import { AccountEntity } from './entities/account.entity';
import { OrganizationDetailEntity } from './entities/organization-detail.entity';
import { AccountMemberEntity } from './entities/account-member.entity';

// Enums
import { ACCOUNT_TYPE_ENUM } from './enums/account-type.enum';
import { ACCOUNT_MEMBER_ROLE_ENUM } from './enums/account-member-role.enum';

// Interfaces
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { RedisService } from 'src/shared/redis/redis.service';
import { AccountData } from './interfaces/response/account-response';

const ACCOUNTS_CATALOG_KEY_PREFIX = 'accounts:';

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @InjectRepository(AccountEntity)
    private accountRepository: Repository<AccountEntity>,

    @InjectRepository(OrganizationDetailEntity)
    private organizationDetailRepository: Repository<OrganizationDetailEntity>,

    @InjectDataSource()
    private dataSource: DataSource,

    private redisService: RedisService,
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

  async findOne(id: string): Promise<BaseResponse<AccountEntity>> {
    const account = await this.findEntityById(id);

    return {
      success: true,
      message: 'Cuenta obtenida correctamente',
      data: account,
    };
  }

  async update(
    id: string,
    updateAccountDto: UpdateAccountDto,
  ): Promise<BaseResponse<AccountEntity>> {
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

    return {
      success: true,
      message: 'Cuenta actualizada correctamente',
      data: await this.findEntityById(id),
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
   * Crea la cuenta PERSONAL por defecto de un usuario recién registrado y su
   * membresía como OWNER. Recibe el EntityManager del llamador para poder
   * enlistarse en la transacción de registro (no abre su propia transacción).
   */
  async createDefaultPersonalAccount(
    manager: EntityManager,
    userId: string,
    accountName: string,
  ): Promise<AccountEntity> {
    const account = await manager.save(
      manager.create(AccountEntity, {
        name: accountName,
        type: ACCOUNT_TYPE_ENUM.PERSONAL,
      }),
    );

    await manager.save(
      manager.create(AccountMemberEntity, {
        accountId: account.id,
        userId,
        role: [ACCOUNT_MEMBER_ROLE_ENUM.OWNER],
      }),
    );

    return account;
  }

  /**
   * Crea una Organización de forma transaccional: Account(type=ORGANIZATION),
   * OrganizationDetail, y la membresía OWNER del usuario autenticado. Al
   * confirmar, refresca el catálogo de cuentas cacheado en Redis.
   */
  async createOrganization(
    userId: string,
    dto: CreateOrganizationDto,
  ): Promise<BaseResponse<AccountEntity>> {
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

      await queryRunner.manager.save(
        queryRunner.manager.create(AccountMemberEntity, {
          accountId: account.id,
          userId,
          role: [ACCOUNT_MEMBER_ROLE_ENUM.OWNER],
        }),
      );

      await queryRunner.commitTransaction();

      const fullAccount = await this.findEntityById(account.id);
      await this.appendAccountToCatalog(userId, fullAccount);

      return {
        success: true,
        message: 'Organización creada correctamente',
        data: fullAccount,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Agrega una cuenta al catálogo cacheado en Redis DB 0 bajo la key
   * accounts:{userId} (lectura-modificación-escritura). Un fallo de Redis
   * nunca debe tumbar la operación que lo dispara.
   */
  async appendAccountToCatalog(
    userId: string,
    account: AccountEntity,
  ): Promise<void> {
    try {
      const key = ACCOUNTS_CATALOG_KEY_PREFIX + userId;
      const existingRaw = await this.redisService.get(key);
      const catalog: AccountData[] = existingRaw ? JSON.parse(existingRaw) : [];

      catalog.push(this.toCatalogEntry(account));

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

  private toCatalogEntry(account: AccountEntity): AccountData {
    return {
      id: account.id,
      name: account.name,
      type: account.type,
      createdAt: account.createdAt,
      organizationDetail: account.organizationDetail
        ? { name: account.organizationDetail.name }
        : null,
    };
  }
}

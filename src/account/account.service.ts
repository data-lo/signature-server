import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { UpdateAccountDto } from './dto/update-account.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';

import { AccountEntity } from './entities/account.entity';
import { OrganizationEntity } from './entities/organization.entity';
import { UserEntity } from 'src/user/entities/user.entity';

import { ACCOUNT_TYPE_ENUM } from './enums/account-type.enum';
import { ACCOUNT_STATUS_ENUM } from './enums/account-status.enum';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

import { RolesService } from 'src/roles/roles.service';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { RedisService } from 'src/shared/redis/redis.service';
import { AccountData } from './interfaces/response/account-response';

const ACCOUNTS_CATALOG_KEY_PREFIX = 'accounts:';

/**
 * Concentra las operaciones sobre `accounts`, la fila única por (usuario × contexto) en la que la
 * migración ER-V2 (Fase 5) fusionó el tenant y la membresía. Absorbe lo que antes repartían
 * AccountService y AccountMemberService para todo lo que ya no distingue "la cuenta" de "quién
 * pertenece a ella": son la misma fila.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @InjectRepository(AccountEntity)
    private accountRepository: Repository<AccountEntity>,

    @InjectRepository(OrganizationEntity)
    private organizationRepository: Repository<OrganizationEntity>,

    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,

    @InjectDataSource()
    private dataSource: DataSource,

    private redisService: RedisService,
    private rolesService: RolesService,
  ) {}

  /**
   * Da de alta directamente una fila de `accounts`, con su organización si hace falta. Quién puede
   * crearla y con qué rol lo decide el caso de uso; acá sólo se escribe.
   *
   * `email`/`password` se copian del usuario porque son la credencial única sincronizada
   * (decisión D6 del plan ER-V2): el login resuelve contra `accounts`, así que una fila sin
   * esos campos sería una cuenta con la que su dueño no podría entrar.
   */
  async saveAccount(params: {
    userId: string;
    accountType: ACCOUNT_TYPE_ENUM;
    organizationId: string | null;
    roleId: string;
    user: UserEntity;
  }): Promise<AccountEntity> {
    return this.accountRepository.save(
      this.accountRepository.create({
        userId: params.userId,
        accountType: params.accountType,
        organizationId: params.organizationId,
        roleId: params.roleId,
        status: ACCOUNT_STATUS_ENUM.ACTIVE,
        email: params.user.email,
        password: params.user.password,
        isActive: true,
        joinedAt: new Date(),
      }),
    );
  }

  /** Alta de la fila `organizations` con el perfil que llega del formulario. */
  async saveOrganization(profile: {
    name: string;
    address?: string | null;
    rfc?: string | null;
    domainAllowed?: string | null;
    phoneNumber?: string | null;
    indexDocuments?: boolean;
  }): Promise<OrganizationEntity> {
    return this.organizationRepository.save(
      this.organizationRepository.create({
        name: profile.name,
        address: profile.address ?? null,
        rfc: profile.rfc ?? null,
        domainAllowed: profile.domainAllowed ?? null,
        phoneNumber: profile.phoneNumber ?? null,
        indexDocuments: profile.indexDocuments ?? false,
      }),
    );
  }

  /** Usuario por id, exigiendo que exista. */
  async findUserOrFail(userId: string): Promise<UserEntity> {
    const currentUser = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!currentUser) {
      throw new NotFoundException(`Usuario con ID ${userId} no encontrado`);
    }

    return currentUser;
  }

  /** Escribe sólo los campos del perfil de organización que vinieron en el DTO. */
  async updateOrganizationDetails(
    organizationId: string,
    dto: UpdateAccountDto,
  ): Promise<void> {
    await this.organizationRepository.update(organizationId, {
      ...(dto.organizationName !== undefined && {
        name: dto.organizationName,
      }),
      ...(dto.address !== undefined && { address: dto.address }),
      ...(dto.rfc !== undefined && { rfc: dto.rfc }),
      ...(dto.domainAllowed !== undefined && {
        domainAllowed: dto.domainAllowed,
      }),
      ...(dto.phoneNumber !== undefined && { phoneNumber: dto.phoneNumber }),
      ...(dto.indexDocuments !== undefined && {
        indexDocuments: dto.indexDocuments,
      }),
    });
  }

  /** Todas las cuentas con su organización — consulta administrativa, sin filtro de tenant. */
  async listAll(): Promise<AccountEntity[]> {
    return this.accountRepository.find({ relations: { organization: true } });
  }

  async findByIdOrFail(id: string): Promise<AccountEntity> {
    const account = await this.accountRepository.findOne({
      where: { id },
      relations: { organization: true },
    });

    if (!account) {
      throw new NotFoundException(`Cuenta con ID ${id} no encontrada`);
    }

    return account;
  }

  /**
   * Exige que el llamador sea el dueño de esa fila de `accounts` y tenga el permiso
   * ORGANIZATION:{action} para leer o actualizar la cuenta e invitar miembros. `accountId` siempre
   * es el contexto propio del llamador, igual que `X-Account-Id` en el resto de la API, nunca la
   * fila de otro usuario.
   *
   * Devuelve la cuenta para que el caller no tenga que volver a consultarla. Resuelve el permiso con
   * `RolesService.hasPermission` en vez de comparar `role.name === 'ADMIN'` a mano —ver su docblock.
   */
  async assertHasOrganizationPermission(
    callerId: string,
    accountId: string,
    action: ACTION_KEY_ENUM,
  ): Promise<AccountEntity> {
    const account = await this.accountRepository.findOne({
      where: { id: accountId, userId: callerId, isActive: true },
      relations: { role: true, organization: true },
    });

    const allowed = await this.rolesService.hasPermission(
      account?.roleId,
      RESOURCE_KEY_ENUM.ORGANIZATION,
      action,
    );

    if (!account || !allowed) {
      throw new ForbiddenException(
        'No tienes permisos de administrador sobre esta cuenta',
      );
    }

    return account;
  }

  /**
   * Crea la cuenta PERSONAL por defecto de un usuario recién registrado.
   *
   * Recibe el EntityManager del llamador para enlistarse en la transacción de registro en vez de
   * abrir la suya. `email`/`password` llegan por parámetro —y no de una consulta nueva— porque
   * `UserService.createFromSignup` ya los tiene en memoria dentro de esa misma transacción; son la
   * credencial única sincronizada (decisión D6).
   */
  async createDefaultPersonalAccount(
    manager: EntityManager,
    userId: string,
    email: string,
    password: string,
  ): Promise<{ account: AccountEntity }> {
    const adminRole = await this.rolesService.findSystemRoleByName(
      SYSTEM_ROLE_NAME_ENUM.ADMIN,
    );

    const account = await manager.save(
      manager.create(AccountEntity, {
        userId,
        accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
        organizationId: null,
        roleId: adminRole.id,
        status: ACCOUNT_STATUS_ENUM.ACTIVE,
        email,
        password,
        isActive: true,
        joinedAt: new Date(),
      }),
    );

    return { account };
  }

  /**
   * Crea la organización y la membresía ADMIN de su creador en una sola transacción.
   *
   * Van juntas porque una organización sin ningún administrador no la puede gestionar nadie:
   * si el segundo save fallara con el primero ya confirmado, quedaría una organización
   * inaccesible y sin forma de repararla desde la API.
   *
   * El creador queda como administrador de inmediato, igual que en la cuenta personal.
   */
  async saveOrganizationWithAdminAccount(
    user: UserEntity,
    dto: CreateOrganizationDto,
  ): Promise<AccountEntity> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const organization = await queryRunner.manager.save(
        queryRunner.manager.create(OrganizationEntity, {
          name: dto.organizationName,
          address: dto.address ?? null,
          rfc: dto.rfc ?? null,
          domainAllowed: dto.domainAllowed ?? null,
          phoneNumber: dto.phoneNumber ?? null,
          indexDocuments: dto.indexDocuments ?? false,
        }),
      );

      const adminRole = await this.rolesService.findSystemRoleByName(
        SYSTEM_ROLE_NAME_ENUM.ADMIN,
      );

      const account = await queryRunner.manager.save(
        queryRunner.manager.create(AccountEntity, {
          userId: user.id,
          accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
          organizationId: organization.id,
          roleId: adminRole.id,
          status: ACCOUNT_STATUS_ENUM.ACTIVE,
          email: user.email,
          password: user.password,
          isActive: true,
          joinedAt: new Date(),
        }),
      );

      await queryRunner.commitTransaction();

      return this.findByIdOrFail(account.id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Agrega una cuenta al catálogo cacheado en Redis DB 0 bajo `accounts:{userId}`
   * (lectura-modificación-escritura). Un fallo de Redis nunca debe tumbar la operación que lo
   * dispara.
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
   * Refresca la entrada de esta organización en el catálogo cacheado de cada miembro activo, tras
   * renombrar o actualizar su perfil, para que el switcher del frontend no muestre datos obsoletos.
   */
  async refreshCatalogForOrganizationMembers(
    organizationId: string,
  ): Promise<void> {
    const members = await this.accountRepository.find({
      where: { organizationId, isActive: true },
      relations: { organization: true },
    });

    await Promise.all(
      members.map((member) =>
        this.replaceAccountInCatalog(member.userId, member),
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

      catalog[index] = this.toCatalogEntry(account);
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
   * Quita una cuenta del catálogo cacheado del usuario al revocarle el acceso, para que el switcher
   * del frontend no siga ofreciendo una cuenta que ya no puede abrir.
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
   * Lee el catálogo de cuentas del usuario exclusivamente desde Redis DB 0, sin fallback a
   * PostgreSQL. Si la key no existe, devuelve un catálogo vacío.
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

  /**
   * Resuelve una cuenta activa por email, que es como `AuthService.login()` obtiene el userId: el
   * login autentica contra `Account.email` —sincronizado desde la credencial única del usuario,
   * decisión D6— en vez de contra `User.email`.
   *
   * Un usuario puede tener varias filas con el mismo email sincronizado (una por organización);
   * cualquiera sirve.
   */
  async findActiveAccountByEmail(email: string): Promise<AccountEntity | null> {
    return this.accountRepository.findOne({
      where: { email, isActive: true },
    });
  }

  /**
   * Resincroniza la contraseña en TODAS las filas de `accounts` del usuario (personal y membresías)
   * tras cambiar `UserEntity.password`.
   *
   * `login()` autentica contra `Account.email`/`.password` (decisión D6), no contra
   * `User.password`: sin esto, un reset dejaría al usuario sin poder entrar con la contraseña nueva.
   */
  async updatePasswordForUser(
    userId: string,
    hashedPassword: string,
  ): Promise<void> {
    await this.accountRepository.update(
      { userId },
      { password: hashedPassword },
    );
  }

  /**
   * Resincroniza el correo en las filas de `accounts` del usuario, contraparte de
   * `updatePasswordForUser` para el otro campo copiado desde UserEntity. La usa la corrección de un
   * registro sin verificar; sin ella `login()`, que resuelve la credencial por `Account.email`,
   * seguiría buscando el correo viejo y el usuario no podría entrar con el que acaba de verificar.
   *
   * Acepta un EntityManager para correr dentro de la misma transacción que actualiza al usuario, y
   * que credencial y usuario nunca queden desincronizados a medias.
   */
  async updateEmailForUser(
    userId: string,
    email: string,
    manager?: EntityManager,
  ): Promise<void> {
    const repository = manager
      ? manager.getRepository(AccountEntity)
      : this.accountRepository;

    await repository.update({ userId }, { email });
  }

  toCatalogEntry(account: AccountEntity): AccountData {
    return {
      id: account.id,
      type: account.accountType,
      createdAt: account.createdAt,
      organizationId: account.organizationId,
      organizationDetail: account.organization
        ? { name: account.organization.name }
        : null,
      roleId: account.roleId,
      isActive: account.isActive,
    };
  }
}

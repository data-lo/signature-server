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
import { OrganizationEntity } from './entities/organization.entity';
import { UserEntity } from 'src/user/entities/user.entity';

// Enums
import { ACCOUNT_TYPE_ENUM } from './enums/account-type.enum';
import { ACCOUNT_STATUS_ENUM } from './enums/account-status.enum';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

// Services
import { RolesService } from 'src/roles/roles.service';

// Interfaces
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { RedisService } from 'src/shared/redis/redis.service';
import { AccountData } from './interfaces/response/account-response';

const ACCOUNTS_CATALOG_KEY_PREFIX = 'accounts:';

/**
 * AccountEntity fusiona lo que antes eran AccountEntity (el tenant) + AccountMemberEntity (la
 * membresía) en una sola fila por (usuario × contexto) — ver plan de migración ER-V2, Fase 5.
 * Este servicio absorbe toda la lógica que antes vivía repartida entre AccountService y
 * AccountMemberService para las operaciones que ya no distinguen "la cuenta" de "quién
 * pertenece a ella": ambas cosas son la misma fila ahora.
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
   * Creación genérica de cuenta — sin consumidor real en el frontend hoy (que usa
   * `POST /api/v1/organizations` para organizaciones y el registro para la cuenta personal).
   * Se mantiene funcional y correcta contra el modelo fusionado, sin pulir más allá de eso.
   */
  async create(
    currentUserId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<BaseResponse<AccountData>> {
    const currentUser = await this.userRepository.findOne({
      where: { id: currentUserId },
    });
    if (!currentUser) {
      throw new NotFoundException(`Usuario con ID ${currentUserId} no encontrado`);
    }

    const adminRole = await this.rolesService.findSystemRoleByName(
      SYSTEM_ROLE_NAME_ENUM.ADMIN,
    );

    let organizationId: string | null = null;
    if (createAccountDto.type === ACCOUNT_TYPE_ENUM.ORGANIZATION) {
      const organization = await this.organizationRepository.save(
        this.organizationRepository.create({
          name: createAccountDto.organizationName ?? createAccountDto.name,
          address: createAccountDto.address ?? null,
          rfc: createAccountDto.rfc ?? null,
          domainAllowed: createAccountDto.domainAllowed ?? null,
          phoneNumber: createAccountDto.phoneNumber ?? null,
          indexDocuments: createAccountDto.indexDocuments ?? false,
        }),
      );
      organizationId = organization.id;
    }

    const account = await this.accountRepository.save(
      this.accountRepository.create({
        userId: currentUserId,
        accountType: createAccountDto.type,
        organizationId,
        roleId: adminRole.id,
        status: ACCOUNT_STATUS_ENUM.ACTIVE,
        email: currentUser.email,
        password: currentUser.password,
        isActive: true,
        joinedAt: new Date(),
      }),
    );

    const fullAccount = await this.findEntityById(account.id);
    return {
      success: true,
      message: 'Cuenta creada correctamente',
      data: this.toCatalogEntry(fullAccount),
    };
  }

  async findAll(): Promise<BaseResponse<AccountEntity[]>> {
    const accounts = await this.accountRepository.find({
      relations: { organization: true },
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
  ): Promise<BaseResponse<AccountData>> {
    const account = await this.assertHasOrganizationPermission(
      callerId,
      id,
      ACTION_KEY_ENUM.READ,
    );

    return {
      success: true,
      message: 'Cuenta obtenida correctamente',
      data: this.toCatalogEntry(account),
    };
  }

  async update(
    callerId: string,
    id: string,
    updateAccountDto: UpdateAccountDto,
  ): Promise<BaseResponse<AccountData>> {
    const account = await this.assertHasOrganizationPermission(
      callerId,
      id,
      ACTION_KEY_ENUM.UPDATE,
    );

    const hasOrganizationDetailChanges =
      updateAccountDto.organizationName !== undefined ||
      updateAccountDto.address !== undefined ||
      updateAccountDto.rfc !== undefined ||
      updateAccountDto.domainAllowed !== undefined ||
      updateAccountDto.phoneNumber !== undefined ||
      updateAccountDto.indexDocuments !== undefined;

    if (
      account.accountType === ACCOUNT_TYPE_ENUM.ORGANIZATION &&
      account.organizationId &&
      hasOrganizationDetailChanges
    ) {
      await this.organizationRepository.update(account.organizationId, {
        ...(updateAccountDto.organizationName !== undefined && {
          name: updateAccountDto.organizationName,
        }),
        ...(updateAccountDto.address !== undefined && {
          address: updateAccountDto.address,
        }),
        ...(updateAccountDto.rfc !== undefined && { rfc: updateAccountDto.rfc }),
        ...(updateAccountDto.domainAllowed !== undefined && {
          domainAllowed: updateAccountDto.domainAllowed,
        }),
        ...(updateAccountDto.phoneNumber !== undefined && {
          phoneNumber: updateAccountDto.phoneNumber,
        }),
        ...(updateAccountDto.indexDocuments !== undefined && {
          indexDocuments: updateAccountDto.indexDocuments,
        }),
      });
    }

    const updatedAccount = await this.findEntityById(id);

    if (hasOrganizationDetailChanges && updatedAccount.organizationId) {
      await this.refreshCatalogForOrganizationMembers(
        updatedAccount.organizationId,
      );
    }

    return {
      success: true,
      message: 'Cuenta actualizada correctamente',
      data: this.toCatalogEntry(updatedAccount),
    };
  }

  private async findEntityById(id: string): Promise<AccountEntity> {
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
   * Solo el propio dueño de esa fila de Account, con permiso ORGANIZATION:{action}, puede
   * leer/actualizar la cuenta o invitar miembros. `accountId` siempre se refiere al contexto
   * propio del llamador (mismo criterio que `X-Account-Id` en el resto de la API) — nunca a la
   * fila de otro usuario. Retorna la cuenta para que el caller no tenga que volver a
   * consultarla. Permiso granular vía `RolesService.hasPermission` en vez de comparar
   * `role.name === 'ADMIN'` a mano — ver docblock de `hasPermission` para el porqué.
   */
  private async assertHasOrganizationPermission(
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
   * Crea la cuenta PERSONAL por defecto de un usuario recién registrado. Recibe el
   * EntityManager del llamador para poder enlistarse en la transacción de registro (no abre su
   * propia transacción). `email`/`password` sincronizan la credencial única del usuario
   * (decisión D6, ver plan de migración ER-V2) — se reciben como parámetro en vez de
   * volver a consultarlas porque el caller (`UserService.createFromSignup`) ya las tiene en
   * memoria dentro de la misma transacción.
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
   * Crea una Organización de forma transaccional: Organization (entidad propia, ver Fase 5) +
   * Account(type=ORGANIZATION) para el usuario autenticado con el rol de sistema ADMIN (el
   * creador queda como administrador de inmediato, igual que en la cuenta personal). Al
   * confirmar, refresca el catálogo de cuentas cacheado en Redis.
   */
  async createOrganization(
    userId: string,
    dto: CreateOrganizationDto,
  ): Promise<BaseResponse<AccountData>> {
    const currentUser = await this.userRepository.findOne({
      where: { id: userId },
    });
    if (!currentUser) {
      throw new NotFoundException(`Usuario con ID ${userId} no encontrado`);
    }

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
          userId,
          accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
          organizationId: organization.id,
          roleId: adminRole.id,
          status: ACCOUNT_STATUS_ENUM.ACTIVE,
          email: currentUser.email,
          password: currentUser.password,
          isActive: true,
          joinedAt: new Date(),
        }),
      );

      await queryRunner.commitTransaction();

      const fullAccount = await this.findEntityById(account.id);
      await this.appendAccountToCatalog(userId, fullAccount);

      return {
        success: true,
        message: 'Organización creada correctamente',
        data: this.toCatalogEntry(fullAccount),
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Valida que el llamador pueda invitar a la organización activa: ADMIN de esa cuenta, cuenta
   * de tipo ORGANIZATION, roleId existente. Devuelve el `organizationId` resuelto (distinto del
   * `accountId` recibido — ese es la fila de membresía del propio llamador) para que el caller
   * (`OrganizationsController.invite`, ver historia [STORY] Eventos Kafka, Email (SendGrid) y
   * Miembros (/join)) pueda persistir la invitación real y publicar el evento de Kafka. Esta
   * validación vive aquí (no en `OrganizationInvitationService`) para no crear una dependencia
   * circular entre ambos servicios — `OrganizationInvitationService` ya depende de
   * `AccountService` (para refrescar el catálogo de Redis al aceptar), así que el sentido
   * contrario se evita a propósito orquestando desde el controller.
   */
  async inviteMember(
    callerId: string,
    accountId: string,
    dto: InviteMemberDto,
  ): Promise<BaseResponse<{ organizationId: string }>> {
    if (!accountId) {
      throw new BadRequestException(
        'Falta el header X-Account-Id de la organización activa',
      );
    }

    const account = await this.assertHasOrganizationPermission(
      callerId,
      accountId,
      ACTION_KEY_ENUM.CREATE,
    );

    if (account.accountType !== ACCOUNT_TYPE_ENUM.ORGANIZATION) {
      throw new BadRequestException(
        'Solo se pueden invitar miembros a una cuenta de tipo ORGANIZATION',
      );
    }

    await this.rolesService.findByIdOrFail(dto.roleId);

    return {
      success: true,
      message: 'Invitación validada correctamente',
      data: { organizationId: account.organizationId as string },
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
   * Refresca la entrada de esta organización dentro del catálogo cacheado en Redis de cada
   * miembro activo. Se usa tras renombrar/actualizar el perfil de una organización
   * (`update()`) para que el switcher del frontend no muestre datos obsoletos indefinidamente.
   */
  private async refreshCatalogForOrganizationMembers(
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
   * Quita una cuenta del catálogo cacheado en Redis del usuario. Se usa al
   * revocar el acceso de un miembro, para que el switcher del frontend no
   * siga ofreciendo una cuenta a la que el usuario ya no tiene acceso.
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

  /**
   * Resuelve una cuenta activa por email — usado por AuthService.login() (ver plan de
   * migración ER-V2, Fase 5): el login ahora resuelve contra `Account.email` (sincronizado
   * desde la credencial única del usuario, decisión D6) en vez de `User.email` directamente.
   * Un usuario puede tener varias filas de Account (una por organización) con el mismo email
   * sincronizado; cualquiera de ellas sirve para resolver el userId.
   */
  async findActiveAccountByEmail(email: string): Promise<AccountEntity | null> {
    return this.accountRepository.findOne({
      where: { email, isActive: true },
    });
  }

  private toCatalogEntry(account: AccountEntity): AccountData {
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

// External dependencies
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

// DTOs
import { UpdateAccountDto } from './dto/update-account.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';

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
import { BillingProfileProvisioningService } from 'src/billing/profiles/billing-profile-provisioning.service';
import { toBillingOwner } from 'src/billing/profiles/billing-owner.util';

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
    private billingProfileProvisioning: BillingProfileProvisioningService,
  ) {}

  /**
   * Alta directa de una fila de `accounts`, con su organización si hace falta. Quién puede
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
    /**
     * La transacción es nueva y la trae esta historia: desde que toda cuenta nace con su
     * `billing_profile`, guardar la fila sola dejaría una cuenta sin estado comercial si el
     * perfil fallara — el hueco que este cambio existe para cerrar.
     *
     * Sigue quedando FUERA la organización que el caso de uso crea antes de llamar acá: ese
     * reparto es el que ya tenía el endpoint (ver `CreateAccountUseCase`) y no lo toca esta
     * historia.
     */
    return this.dataSource.transaction(async (manager) => {
      const account = await manager.save(
        manager.create(AccountEntity, {
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

      await this.billingProfileProvisioning.provisionFreeProfile(
        manager,
        toBillingOwner(account),
      );

      return account;
    });
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
   * Solo el propio dueño de esa fila de Account, con permiso ORGANIZATION:{action}, puede
   * leer/actualizar la cuenta o invitar miembros. `accountId` siempre se refiere al contexto
   * propio del llamador (mismo criterio que `X-Account-Id` en el resto de la API) — nunca a la
   * fila de otro usuario. Retorna la cuenta para que el caller no tenga que volver a
   * consultarla. Permiso granular vía `RolesService.hasPermission` en vez de comparar
   * `role.name === 'ADMIN'` a mano — ver docblock de `hasPermission` para el porqué.
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

    /**
     * Con el MISMO `manager`, es decir dentro de la transacción de registro: un usuario que se
     * da de alta sale de aquí con cuenta personal y perfil Free, o no sale con ninguna de las
     * dos. Es el propietario naciendo completo, no un paso posterior que pueda quedarse a medias.
     */
    await this.billingProfileProvisioning.provisionFreeProfile(
      manager,
      toBillingOwner(account),
    );

    return { account };
  }

  /**
   * Crea una Organización de forma transaccional: Organization (entidad propia, ver Fase 5) +
   * Account(type=ORGANIZATION) para el usuario autenticado con el rol de sistema ADMIN (el
   * creador queda como administrador de inmediato, igual que en la cuenta personal). Al
   * confirmar, refresca el catálogo de cuentas cacheado en Redis.
   */
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

      /**
       * El propietario del dinero es la ORGANIZACIÓN, no la membresía de quien la creó: el
       * perfil se ata a `organization_id` para que todos sus miembros compartan un solo estado
       * comercial y un solo saldo. Va en la misma transacción que la organización y su
       * administrador, por el mismo motivo que ellas van juntas.
       */
      await this.billingProfileProvisioning.provisionFreeProfile(
        queryRunner.manager,
        { personalAccountId: null, organizationId: organization.id },
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

  /**
   * Resincroniza la contraseña en TODAS las filas AccountEntity del usuario (personal +
   * memberships de organización) tras un cambio en UserEntity.password. Necesario porque
   * `login()` autentica contra Account.email/.password (decisión D6), no contra User.password
   * directamente — sin esto, un reset de contraseña dejaría al usuario sin poder loguearse con
   * la contraseña nueva (ver historia "Recuperación de Contraseña mediante Código de
   * Verificación OTP").
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
   * Contraparte de `updatePasswordForUser` para el otro campo sincronizado desde UserEntity: el
   * correo. Se usa al corregir un registro sin verificar (ver UserService.updatePreRegistration);
   * sin esto `login()`, que resuelve la credencial por Account.email, seguiría buscando el correo
   * viejo y el usuario no podría entrar con el que acaba de verificar.
   *
   * Acepta un EntityManager para poder correr dentro de la misma transacción que actualiza al
   * usuario, y que credencial y usuario nunca queden desincronizados a medias.
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

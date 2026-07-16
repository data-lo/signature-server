// External dependencies
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

// DTOs
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdatePersonalInformationDto } from './dto/update-personal-information.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';

// Entities
import { UserEntity } from './entities/user.entity';
import { PersonalInformationEntity } from './entities/personal-information.entity';

// Enums
import { UserRoles } from './enums/user-roles';

// Interfaces
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { SignatureService } from 'src/signature/signature.service';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { RedisService } from 'src/shared/redis/redis.service';
import { AccountService } from 'src/account/account.service';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(PersonalInformationEntity)
    private personalInformationRepository: Repository<PersonalInformationEntity>,
    @InjectDataSource()
    private dataSource: DataSource,

    private signatureService: SignatureService,
    private redisService: RedisService,
    private accountService: AccountService,
  ) {}

  async create(
    createUserDto: CreateUserDto,
  ): Promise<BaseResponse<UserEntity>> {
    const existingUser = await this.userRepository.findOne({
      where: { email: createUserDto.email.toLowerCase() },
    });
    if (existingUser) {
      throw new ConflictException(
        'Ya existe un usuario registrado con ese correo electrónico',
      );
    }

    if (createUserDto.nationalId) {
      await this.assertCurpNotTaken(createUserDto.nationalId.toUpperCase());
    }
    if (createUserDto.rfc) {
      await this.assertRfcNotTaken(createUserDto.rfc.toUpperCase());
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const personalInformation = await queryRunner.manager.save(
        queryRunner.manager.create(PersonalInformationEntity, {
          name: createUserDto.firstName?.toUpperCase(),
          lastName: createUserDto.lastName?.toUpperCase(),
          curp: createUserDto.nationalId?.toUpperCase(),
          rfc: createUserDto.rfc?.toUpperCase(),
        }),
      );

      const user = queryRunner.manager.create(UserEntity, {
        ...(createUserDto.firstName && {
          firstName: createUserDto.firstName.toUpperCase(),
        }),
        ...(createUserDto.lastName && {
          lastName: createUserDto.lastName.toUpperCase(),
        }),
        ...(createUserDto.email && {
          email: createUserDto.email.toLowerCase(),
        }),
        ...(createUserDto.position && {
          position: createUserDto.position.toUpperCase(),
        }),
        roles: createUserDto.roles ?? [UserRoles.SIGNER],
        ...(createUserDto.nationalId && {
          nationalId: createUserDto.nationalId.toUpperCase(),
        }),
        personalInformationId: personalInformation.id,
      });

      const newUser = await queryRunner.manager.save(user);
      await queryRunner.commitTransaction();

      return {
        success: true,
        message: 'Usuario creado correctamente',
        data: this.removeSensitiveData(newUser),
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async findAllActiveUsers(
    withSignature = false,
  ): Promise<BaseResponse<UserEntity[]>> {
    const users = await this.userRepository.find({
      where: { isActive: true },
      ...(withSignature && {
        relations: { signature: true },
        select: {
          signature: {
            id: true,
            signatureObjectKey: true,
          },
        },
      }),
    });

    if (!users || users.length === 0) {
      return {
        success: true,
        message: 'No hay usuarios registrados',
        data: [],
      };
    }

    const secureUsers = await Promise.all(
      users.map(async (user) => {
        const { signature: _rawSignature, ...sanitizedUser } =
          this.removeSensitiveData(user);

        if (withSignature && user.signature?.signatureObjectKey) {
          try {
            const signature = await this.signatureService.getFile(
              user.signature.signatureObjectKey,
              BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
            );

            return {
              ...sanitizedUser,
              signature: {
                id: user.signature.id,
                secureUrl: signature.secureUrl,
                expiresIn: signature.expiresIn,
              },
            };
          } catch {
            return sanitizedUser;
          }
        }
        return sanitizedUser;
      }),
    );

    return {
      success: true,
      message: 'Usuarios obtenidos correctamente',
      data: secureUsers as any,
    };
  }

  async findOneActiveUser(
    id: string,
    withSignature = false,
  ): Promise<BaseResponse<UserEntity | null>> {
    const user = await this.userRepository.findOne({
      where: { id, isActive: true },
      relations: {
        personalInformation: true,
        ...(withSignature && { signature: true }),
      },
      select: {
        personalInformation: {
          phoneNumber: true,
          secondaryEmail: true,
          rfc: true,
        },
        ...(withSignature && {
          signature: {
            id: true,
            signatureObjectKey: true,
            officialCardObjectKey: true,
          },
        }),
      },
    });

    if (!user) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
    }

    let signature;
    let officialFile;

    const {
      signature: _rawSignature,
      personalInformation,
      ...sanitizedUser
    } = this.removeSensitiveData(user);

    if (withSignature && user.signature?.signatureObjectKey) {
      try {
        signature = await this.signatureService.getFile(
          user.signature.signatureObjectKey,
          BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
        );
      } catch {
        signature = null;
      }
    }

    if (withSignature && user.signature?.officialCardObjectKey) {
      try {
        officialFile = await this.signatureService.getFile(
          user.signature.officialCardObjectKey,
          BUCKET_TYPES_ENUM.OFICIAL_CARDS,
        );
      } catch {
        officialFile = null;
      }
    }

    const newUserObject = {
      ...sanitizedUser,
      phoneNumber: personalInformation?.phoneNumber ?? null,
      secondaryEmail: personalInformation?.secondaryEmail ?? null,
      rfc: personalInformation?.rfc ?? null,
      ...(withSignature &&
        signature && {
          signature: {
            id: user.signature.id,
            secureUrl: signature.secureUrl,
            expiresIn: signature.expiresIn,
          },
        }),
      ...(withSignature &&
        officialFile && {
          officialFile: {
            id: user.signature.id,
            secureUrl: officialFile.secureUrl,
            expiresIn: officialFile.expiresIn,
          },
        }),
    };

    return {
      success: true,
      message: 'Usuario obtenido correctamente',
      data: newUserObject as any,
    };
  }

  async update(
    id: string,
    updateUserDto: UpdateUserDto,
  ): Promise<BaseResponse<any>> {
    await this.userRepository.update(id, {
      ...(updateUserDto.firstName && {
        firstName: updateUserDto.firstName.toUpperCase(),
      }),
      ...(updateUserDto.lastName && {
        lastName: updateUserDto.lastName.toUpperCase(),
      }),
      ...(updateUserDto.email && { email: updateUserDto.email.toLowerCase() }),
      ...(updateUserDto.position && {
        position: updateUserDto.position.toUpperCase(),
      }),
      ...(updateUserDto.roles && { roles: updateUserDto.roles }),
    });

    const updatedUser = await this.findOneActiveUser(id);

    return {
      success: true,
      message: 'Usuario actualizado correctamente',
      data: updatedUser,
    };
  }

  async findOne(id: string): Promise<UserEntity> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new Error('Usuario no encontrado');
    }
    if (!user.isActive) {
      throw new Error('Usuario no activo, no asignar a firmas');
    }
    return user;
  }

  async findOneByEmail(email: string): Promise<UserEntity> {
    return this.userRepository.findOne({ where: { email, isDeleted: false } });
  }

  async remove(id: string): Promise<BaseResponse> {
    const result = await this.userRepository.update(
      { id, isActive: true },
      { isDeleted: true, isActive: false },
    );

    if (result.affected === 0) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
    }

    return {
      success: true,
      message: 'Usuario eliminado correctamente',
    };
  }

  private removeSensitiveData(user: UserEntity): UserEntity;
  private removeSensitiveData(user: UserEntity[]): UserEntity[];
  private removeSensitiveData(
    user: UserEntity | UserEntity[],
  ): UserEntity | UserEntity[] {
    const strip = ({
      personalInformationId,
      createdAt,
      updatedAt,
      isActive,
      isDeleted,
      password,
      ...safeUser
    }: UserEntity) => safeUser as UserEntity;

    return Array.isArray(user) ? user.map(strip) : strip(user);
  }

  sanitize(user: UserEntity): UserEntity {
    return this.removeSensitiveData(user);
  }

  async createFromSignup(
    dto: {
      firstName: string;
      lastName: string;
      email: string;
      position: string;
      nationalId: string;
      rfc: string;
    },
    hashedPassword: string,
  ): Promise<BaseResponse<UserEntity>> {
    const existingUser = await this.userRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });
    if (existingUser) {
      throw new ConflictException(
        'Ya existe un usuario registrado con ese correo electrónico',
      );
    }

    await this.assertCurpNotTaken(dto.nationalId.toUpperCase());
    await this.assertRfcNotTaken(dto.rfc.toUpperCase());

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const personalInformation = await queryRunner.manager.save(
        queryRunner.manager.create(PersonalInformationEntity, {
          name: dto.firstName.toUpperCase(),
          lastName: dto.lastName.toUpperCase(),
          curp: dto.nationalId.toUpperCase(),
          rfc: dto.rfc.toUpperCase(),
        }),
      );

      const user = queryRunner.manager.create(UserEntity, {
        firstName: dto.firstName.toUpperCase(),
        lastName: dto.lastName.toUpperCase(),
        email: dto.email.toLowerCase(),
        position: dto.position.toUpperCase(),
        roles: [UserRoles.SIGNER],
        nationalId: dto.nationalId.toUpperCase(),
        password: hashedPassword,
        personalInformationId: personalInformation.id,
      });

      const newUser = await queryRunner.manager.save(user);

      const { account: personalAccount, membership } =
        await this.accountService.createDefaultPersonalAccount(
          queryRunner.manager,
          newUser.id,
          `${dto.firstName} ${dto.lastName}`,
        );

      await queryRunner.commitTransaction();

      await this.refreshUserCurpCache(newUser, personalInformation);
      await this.accountService.appendAccountToCatalog(
        newUser.id,
        personalAccount,
        { role: membership.role, isActive: membership.isActive },
      );

      return {
        success: true,
        message: 'Usuario registrado correctamente',
        data: this.removeSensitiveData(newUser),
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Actualiza de forma atómica isConfigured=true (consolidación final del onboarding)
   * y refresca el snapshot cacheado en Redis bajo la key del CURP. El valor recibido
   * en el DTO no se usa: este endpoint es un disparador de consolidación de un solo
   * sentido, no un toggle genérico de estado.
   */
  async updateStatus(
    userId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    dto: UpdateUserStatusDto,
  ): Promise<BaseResponse<{ isConfigured: boolean }>> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`Usuario con ID ${userId} no encontrado`);
    }

    await this.userRepository.update(userId, { isConfigured: true });

    const updatedUser = await this.userRepository.findOne({
      where: { id: userId },
      relations: { personalInformation: true },
    });

    await this.refreshUserCurpCache(
      updatedUser,
      updatedUser.personalInformation,
    );

    return {
      success: true,
      message: 'Estado de configuración actualizado correctamente',
      data: { isConfigured: true },
    };
  }

  /**
   * Construye el snapshot estable del perfil unificado del usuario que se
   * cachea en Redis. Deliberadamente excluye URLs prefirmadas de MinIO
   * (secureUrl/expiresIn) porque expiran y quedarían obsoletas en el cache.
   */
  private buildCurpCachePayload(
    user: UserEntity,
    personalInformation: PersonalInformationEntity,
  ) {
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      position: user.position,
      roles: user.roles,
      nationalId: user.nationalId,
      isConfigured: user.isConfigured,
      signatureId: user.signatureId,
      personalInformation: {
        rfc: personalInformation?.rfc ?? null,
        phoneNumber: personalInformation?.phoneNumber ?? null,
        secondaryEmail: personalInformation?.secondaryEmail ?? null,
      },
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Cachea en Redis DB 0, bajo la key del CURP, el snapshot del perfil
   * unificado del usuario. Un fallo de Redis nunca debe tumbar la operación
   * que lo dispara.
   */
  private async refreshUserCurpCache(
    user: UserEntity,
    personalInformation: PersonalInformationEntity,
  ): Promise<void> {
    try {
      const payload = this.buildCurpCachePayload(user, personalInformation);
      await this.redisService.set(user.nationalId, JSON.stringify(payload));
    } catch (error) {
      this.logger.warn(
        `No se pudo refrescar el cache de Redis para el CURP ${user.nationalId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Resuelve GET /users/me consultando exclusivamente Redis DB 0 por CURP
   * (sin joins ni URLs prefirmadas de MinIO, para una hidratación rápida del
   * store de onboarding en el cliente). Si la key no existe (por ejemplo, un
   * fallo previo de Redis al registrar), reconstruye el snapshot desde
   * PostgreSQL una única vez y lo vuelve a cachear.
   */
  async getMeFromCache(curp: string): Promise<BaseResponse<unknown>> {
    const raw = await this.redisService.get(curp);
    if (raw) {
      return {
        success: true,
        message: 'Usuario obtenido correctamente',
        data: JSON.parse(raw),
      };
    }

    const user = await this.userRepository.findOne({
      where: { nationalId: curp, isActive: true },
      relations: { personalInformation: true },
    });
    if (!user) {
      throw new NotFoundException(`Usuario con CURP ${curp} no encontrado`);
    }

    const payload = this.buildCurpCachePayload(user, user.personalInformation);
    await this.refreshUserCurpCache(user, user.personalInformation);

    return {
      success: true,
      message: 'Usuario obtenido correctamente',
      data: payload,
    };
  }

  /**
   * Refresca el cache de Redis por CURP con el estado actual del usuario en
   * PostgreSQL. Se usa desde operaciones ajenas a este servicio (p. ej. subir
   * la firma digital) que modifican datos incluidos en el snapshot cacheado
   * pero no pasan por `updatePersonalInformation`/`updateStatus`.
   */
  async refreshCurpCacheForUser(userId: string): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: { personalInformation: true },
    });
    if (!user) {
      throw new NotFoundException(`Usuario con ID ${userId} no encontrado`);
    }

    await this.refreshUserCurpCache(user, user.personalInformation);
  }

  async updatePersonalInformation(
    userId: string,
    dto: UpdatePersonalInformationDto,
  ): Promise<BaseResponse<PersonalInformationEntity>> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`Usuario con ID ${userId} no encontrado`);
    }

    await this.personalInformationRepository.update(
      user.personalInformationId,
      { ...dto },
    );

    const updated = await this.personalInformationRepository.findOne({
      where: { id: user.personalInformationId },
    });

    await this.refreshUserCurpCache(user, updated);

    return {
      success: true,
      message: 'Información personal actualizada correctamente',
      data: updated,
    };
  }

  /** Lanza ConflictException si otro usuario activo ya tiene ese CURP registrado. */
  private async assertCurpNotTaken(curp: string): Promise<void> {
    const existing = await this.userRepository.findOne({
      where: { nationalId: curp, isActive: true },
    });
    if (existing) {
      throw new ConflictException(
        'Ya existe un usuario registrado con ese CURP',
      );
    }
  }

  /** Lanza ConflictException si ya existe un registro de información personal con ese RFC. */
  private async assertRfcNotTaken(rfc: string): Promise<void> {
    const existing = await this.personalInformationRepository.findOne({
      where: { rfc },
    });
    if (existing) {
      throw new ConflictException(
        'Ya existe un usuario registrado con ese RFC',
      );
    }
  }
}

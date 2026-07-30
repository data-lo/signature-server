// External dependencies
import {
  BadRequestException,
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
import { EmailService } from 'src/shared/email/email.service';
import { maskEmail } from 'src/shared/utils/mask-email.util';
import { EmailVerificationCodeService } from './email-verification-code.service';
import { SignupPendingVerificationData } from './interfaces/response/signup-pending-verification-response';

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
    private emailService: EmailService,
    private emailVerificationCodeService: EmailVerificationCodeService,
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

  async findOneByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepository.findOne({ where: { email, isDeleted: false } });
  }

  /** Actualiza el hash de contraseña de UserEntity (ver historia "Recuperación de Contraseña mediante Código de Verificación OTP" — AuthService.resetPassword). No sincroniza AccountEntity: ver AccountService.updatePasswordForUser. */
  async updatePassword(userId: string, hashedPassword: string): Promise<void> {
    await this.userRepository.update(userId, { password: hashedPassword });
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

  /**
   * Envía (best-effort) el OTP de verificación de correo. Un fallo de SendGrid nunca debe
   * tumbar el registro/reenvío que lo dispara — el usuario siempre puede pedir otro código
   * desde /auth/resend-otp si este envío en particular falla.
   */
  private async sendRegistrationOtpBestEffort(
    userId: string,
    email: string,
  ): Promise<void> {
    try {
      const verificationCode =
        await this.emailVerificationCodeService.issue(userId);
      await this.emailService.sendRegistrationOtpNotification(
        email,
        verificationCode.code,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo enviar el correo de verificación de registro a ${email}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async createFromSignup(
    dto: {
      firstName: string;
      lastName: string;
      email: string;
      nationalId: string;
      rfc: string;
    },
    hashedPassword: string,
  ): Promise<BaseResponse<SignupPendingVerificationData>> {
    const curp = dto.nationalId.toUpperCase();

    // A diferencia del antiguo assertCurpNotTaken (que solo miraba isActive), aquí importa el
    // estado de verificación: un CURP con una pre-cuenta sin verificar no es un duplicado real,
    // es un registro abandonado a medias (ver historia "Auth: Flujo de Pre-registro,
    // Verificación OTP y Control por CURP").
    const existingByCurp = await this.userRepository.findOne({
      where: { nationalId: curp },
    });

    if (existingByCurp) {
      if (existingByCurp.isEmailVerified) {
        throw new ConflictException(
          'Ya existe un usuario verificado con este CURP. Inicia sesión.',
        );
      }

      // Caso A: reenvía el OTP al correo YA ASOCIADO al pre-registro original — se ignora
      // deliberadamente cualquier email/nombre/RFC reenviado en este intento, para que conocer
      // el CURP de alguien más (no es secreto) no permita secuestrar su pre-registro con un
      // correo propio.
      await this.sendRegistrationOtpBestEffort(
        existingByCurp.id,
        existingByCurp.email,
      );

      return {
        success: true,
        message:
          'Ya existía una solicitud de registro pendiente para este CURP; te reenviamos el código de verificación',
        data: {
          userId: existingByCurp.id,
          email: existingByCurp.email,
          maskedEmail: maskEmail(existingByCurp.email),
          isNewPreRegistration: false,
        },
      };
    }

    const existingByEmail = await this.userRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });
    if (existingByEmail) {
      throw new ConflictException(
        'Ya existe un usuario registrado con ese correo electrónico',
      );
    }

    await this.assertRfcNotTaken(dto.rfc.toUpperCase());

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let newUser: UserEntity;

    try {
      const personalInformation = await queryRunner.manager.save(
        queryRunner.manager.create(PersonalInformationEntity, {
          name: dto.firstName.toUpperCase(),
          lastName: dto.lastName.toUpperCase(),
          curp,
          rfc: dto.rfc.toUpperCase(),
        }),
      );

      const user = queryRunner.manager.create(UserEntity, {
        firstName: dto.firstName.toUpperCase(),
        lastName: dto.lastName.toUpperCase(),
        email: dto.email.toLowerCase(),
        roles: [UserRoles.SIGNER],
        nationalId: curp,
        password: hashedPassword,
        personalInformationId: personalInformation.id,
        isEmailVerified: false,
      });

      newUser = await queryRunner.manager.save(user);

      const { account: personalAccount } =
        await this.accountService.createDefaultPersonalAccount(
          queryRunner.manager,
          newUser.id,
          newUser.email,
          newUser.password,
        );

      await queryRunner.commitTransaction();

      await this.refreshUserCurpCache(newUser, personalInformation);
      await this.accountService.appendAccountToCatalog(
        newUser.id,
        personalAccount,
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    await this.sendRegistrationOtpBestEffort(newUser.id, newUser.email);

    return {
      success: true,
      message: 'Registro iniciado, revisa tu correo para verificar tu cuenta',
      data: {
        userId: newUser.id,
        email: newUser.email,
        maskedEmail: maskEmail(newUser.email),
        isNewPreRegistration: true,
      },
    };
  }

  /**
   * Marca isEmailVerified=true tras un OTP válido (ver AuthService.verifyOtp) y refresca el
   * snapshot cacheado en Redis, igual criterio que updateStatus.
   */
  async markEmailVerified(userId: string): Promise<UserEntity> {
    await this.userRepository.update(userId, { isEmailVerified: true });

    const updatedUser = await this.userRepository.findOne({
      where: { id: userId },
      relations: { personalInformation: true },
    });
    if (!updatedUser) {
      throw new NotFoundException(`Usuario con ID ${userId} no encontrado`);
    }

    await this.refreshUserCurpCache(
      updatedUser,
      updatedUser.personalInformation,
    );

    return updatedUser;
  }

  /**
   * Actualiza de forma atómica isConfigured=true (consolidación final del onboarding)
   * y refresca el snapshot cacheado en Redis bajo la key del CURP. El valor recibido
   * en el DTO no se usa: este endpoint es un disparador de consolidación de un solo
   * sentido, no un toggle genérico de estado.
   */
  /**
   * Bug corregido (ver README, Historia 2): este endpoint confiaba 100% en que el frontend
   * solo lo llamara cuando personalConfigured/signatureConfigured realmente estuvieran en
   * true — no validaba nada server-side, así que cualquier request autenticado a este endpoint
   * marcaba isConfigured=true sin importar el estado real de los datos del usuario. Ahora
   * recalcula ambas condiciones aquí mismo (mismo criterio que el frontend en
   * `auth.slice.ts`: teléfono+correo secundario, y signatureId presente) antes de consolidar.
   */
  async updateStatus(
    userId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    dto: UpdateUserStatusDto,
  ): Promise<BaseResponse<{ isConfigured: boolean }>> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: { personalInformation: true },
    });
    if (!user) {
      throw new NotFoundException(`Usuario con ID ${userId} no encontrado`);
    }

    const personalConfigured = !!(
      user.personalInformation?.phoneNumber &&
      user.personalInformation?.secondaryEmail
    );
    const signatureConfigured = !!user.signatureId;

    if (!personalConfigured || !signatureConfigured) {
      throw new BadRequestException(
        'No puedes consolidar el onboarding todavía: falta completar tu información personal o tu firma digital',
      );
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

  /**
   * Público (sin JWT, ver UsersController) — consumido desde /join y /signup en
   * signature-app para bifurcar el flujo de invitación a organización (ver historia [STORY]
   * Eventos Kafka, Email (SendGrid) y Miembros (/join)): si el RFC ya existe, el usuario puede
   * "unirse con su cuenta"; si no, se le manda a registrarse.
   */
  async checkRfcAvailability(
    rfc: string,
  ): Promise<BaseResponse<{ exists: boolean }>> {
    const existing = await this.personalInformationRepository.findOne({
      where: { rfc: rfc.toUpperCase() },
    });
    return {
      success: true,
      message: 'Disponibilidad del RFC consultada correctamente',
      data: { exists: !!existing },
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

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

// Entities
import { UserEntity } from './entities/user.entity';
import { PersonalInformationEntity } from './entities/personal-information.entity';

// Enums
import { UserRoles } from './enums/user-roles';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from './enums/signing-credential-status.enum';

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

  /**
   * Alta transaccional de un usuario junto con su fila de información personal. Las dos van en
   * la misma transacción porque `users.personal_information_id` es obligatorio: si el segundo
   * save fallara con el primero ya confirmado, quedaría una fila de información personal
   * huérfana que nadie volvería a referenciar.
   *
   * La normalización a mayúsculas/minúsculas se hace acá y no en el caso de uso porque es la
   * forma canónica con la que la columna se consulta después (ver `isRfcRegistered`).
   */
  async saveNewUser(createUserDto: CreateUserDto): Promise<UserEntity> {
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

      return newUser;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /** Lanza ConflictException si ya hay un usuario con ese correo. */
  async assertEmailNotTaken(email: string): Promise<void> {
    const existingUser = await this.userRepository.findOne({
      where: { email: email.toLowerCase() },
    });

    if (existingUser) {
      throw new ConflictException(
        'Ya existe un usuario registrado con ese correo electrónico',
      );
    }
  }

  /**
   * Todos los usuarios activos, saneados y —si se piden— con la URL prefirmada de su firma
   * resuelta contra MinIO.
   *
   * Una URL que no se puede resolver deja al usuario sin el campo `signature` en vez de romper
   * el listado entero: un objeto perdido en MinIO no debe impedir ver a los otros usuarios.
   */
  async listActiveUsers(withSignature = false): Promise<UserEntity[]> {
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
      return [];
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

    return secureUsers as any;
  }

  /**
   * Perfil de un usuario activo, con la información personal aplanada al primer nivel y, si se
   * piden, las URLs prefirmadas de firma y credencial oficial.
   *
   * Lo comparten `GET /user/:id` y `GET /auth/me`: los dos publican exactamente el mismo perfil
   * y sólo cambia de dónde sale el identificador, así que la lectura vive acá y el envoltorio
   * de respuesta en cada caso de uso.
   */
  async getActiveUserProfile(
    id: string,
    withSignature = false,
  ): Promise<UserEntity | null> {
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

    return {
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
    } as any;
  }

  /** Escribe los campos editables de un usuario, normalizados a su forma canónica. */
  async applyUserUpdate(
    id: string,
    updateUserDto: UpdateUserDto,
  ): Promise<void> {
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

  /**
   * Baja lógica: el usuario deja de estar activo pero la fila permanece, porque su id sigue
   * referenciado desde documentos firmados y colaboradores. Borrarla de verdad rompería la
   * trazabilidad de firmas que ya ocurrieron.
   */
  async softDelete(id: string): Promise<void> {
    const result = await this.userRepository.update(
      { id, isActive: true },
      { isDeleted: true, isActive: false },
    );

    if (result.affected === 0) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
    }
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

      await this.refreshCurpCache(newUser, personalInformation);
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
   * Corrige los datos de un registro que todavía no verifica su correo (ver AuthService
   * .updatePreRegistration, que es quien valida la contraseña antes de llamar aquí).
   *
   * Existe porque un error de dedo en el correo dejaba la cuenta imposible de activar: el código
   * de verificación se iba a una dirección inexistente y volver a registrarse tampoco servía —
   * el CURP ya estaba tomado por ese mismo pre-registro, así que `createFromSignup` entraba por
   * su "Caso A" y reenviaba el código *otra vez al correo equivocado*, en un bucle sin salida.
   *
   * Cuando el correo cambia se emite un código nuevo y se manda a la dirección corregida. Los
   * códigos anteriores no se invalidan explícitamente porque `verifyAndConsume` solo mira el
   * último emitido sin usar, y los previos caducan solos a los 15 minutos.
   */
  async updatePreRegistration(
    user: UserEntity,
    changes: {
      email?: string;
      firstName?: string;
      lastName?: string;
      nationalId?: string;
      rfc?: string;
    },
  ): Promise<BaseResponse<SignupPendingVerificationData>> {
    const nextEmail = changes.email?.toLowerCase() ?? user.email;
    const nextCurp = changes.nationalId?.toUpperCase() ?? user.nationalId;
    const nextRfc = changes.rfc?.toUpperCase();

    const emailChanged = nextEmail !== user.email;
    const curpChanged = nextCurp !== user.nationalId;

    if (emailChanged) {
      const existingByEmail = await this.userRepository.findOne({
        where: { email: nextEmail },
      });
      // Un pre-registro abandonado con ese correo tampoco se puede reutilizar: el correo es
      // único en la tabla, así que el conflicto es real aunque la otra cuenta no esté verificada.
      if (existingByEmail && existingByEmail.id !== user.id) {
        throw new ConflictException(
          'Ya existe un usuario registrado con ese correo electrónico',
        );
      }
    }

    if (curpChanged) {
      const existingByCurp = await this.userRepository.findOne({
        where: { nationalId: nextCurp },
      });
      if (existingByCurp && existingByCurp.id !== user.id) {
        throw new ConflictException(
          'Ya existe un usuario registrado con ese CURP',
        );
      }
    }

    const personalInformation =
      await this.personalInformationRepository.findOne({
        where: { id: user.personalInformationId },
      });

    if (nextRfc && nextRfc !== personalInformation?.rfc) {
      const existingByRfc = await this.personalInformationRepository.findOne({
        where: { rfc: nextRfc },
      });
      if (existingByRfc && existingByRfc.id !== user.personalInformationId) {
        throw new ConflictException(
          'Ya existe un usuario registrado con ese RFC',
        );
      }
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    // Bug corregido: TypeORM lanza UpdateValuesMissingError ante un `update` sin campos, y eso
    // ocurría en el caso más común de todos — corregir SOLO el correo deja la actualización de
    // PersonalInformation vacía (nombre, CURP y RFC siguen igual), y el endpoint respondía 500.
    // Cada tabla se toca únicamente si de verdad tiene algo que cambiar.
    const userChanges = {
      ...(changes.firstName && {
        firstName: changes.firstName.toUpperCase(),
      }),
      ...(changes.lastName && { lastName: changes.lastName.toUpperCase() }),
      ...(emailChanged && { email: nextEmail }),
      ...(curpChanged && { nationalId: nextCurp }),
    };
    const personalInformationChanges = {
      ...(changes.firstName && { name: changes.firstName.toUpperCase() }),
      ...(changes.lastName && {
        lastName: changes.lastName.toUpperCase(),
      }),
      ...(curpChanged && { curp: nextCurp }),
      ...(nextRfc && { rfc: nextRfc }),
    };

    try {
      if (Object.keys(userChanges).length > 0) {
        await queryRunner.manager.update(UserEntity, user.id, userChanges);
      }

      if (
        user.personalInformationId &&
        Object.keys(personalInformationChanges).length > 0
      ) {
        await queryRunner.manager.update(
          PersonalInformationEntity,
          user.personalInformationId,
          personalInformationChanges,
        );
      }

      // `login()` autentica contra AccountEntity.email (decisión D6), que es una copia
      // sincronizada: sin esto el usuario verificaría su correo nuevo y después no podría
      // iniciar sesión con él — el mismo motivo por el que existe `updatePasswordForUser`.
      if (emailChanged) {
        await this.accountService.updateEmailForUser(
          user.id,
          nextEmail,
          queryRunner.manager,
        );
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    const updatedUser = await this.userRepository.findOne({
      where: { id: user.id },
      relations: { personalInformation: true },
    });
    if (!updatedUser) {
      throw new NotFoundException(`Usuario con ID ${user.id} no encontrado`);
    }

    // El snapshot de Redis está indexado por CURP: si el CURP se corrigió, el de la key vieja
    // quedaría huérfano apuntando a datos que ya no existen (y GET /users/me lo serviría).
    if (curpChanged) {
      try {
        await this.redisService.del(user.nationalId);
      } catch (error) {
        this.logger.warn(
          `No se pudo limpiar el cache de Redis del CURP anterior ${user.nationalId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await this.refreshCurpCache(updatedUser, updatedUser.personalInformation);

    if (emailChanged) {
      await this.sendRegistrationOtpBestEffort(
        updatedUser.id,
        updatedUser.email,
      );
    }

    return {
      success: true,
      message: emailChanged
        ? 'Actualizamos tus datos y enviamos un código de verificación a tu nuevo correo'
        : 'Actualizamos tus datos de registro',
      data: {
        userId: updatedUser.id,
        email: updatedUser.email,
        maskedEmail: maskEmail(updatedUser.email),
        isNewPreRegistration: false,
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

    await this.refreshCurpCache(updatedUser, updatedUser.personalInformation);

    return updatedUser;
  }

  /**
   * Consolida el onboarding marcando `isConfigured=true`. Quién puede hacerlo y con qué
   * condiciones lo decide `CompleteMyOnboardingUseCase`: acá sólo se escribe la columna.
   */
  async markConfigured(userId: string): Promise<void> {
    await this.userRepository.update(userId, { isConfigured: true });
  }

  /** Usuario con su información personal cargada, o `null` si no existe. */
  async findOneWithPersonalInformation(
    userId: string,
  ): Promise<UserEntity | null> {
    return this.userRepository.findOne({
      where: { id: userId },
      relations: { personalInformation: true },
    });
  }

  /** Usuario activo por CURP, con su información personal cargada. */
  async findActiveByNationalId(curp: string): Promise<UserEntity | null> {
    return this.userRepository.findOne({
      where: { nationalId: curp, isActive: true },
      relations: { personalInformation: true },
    });
  }

  /**
   * Construye el snapshot estable del perfil unificado del usuario que se
   * cachea en Redis. Deliberadamente excluye URLs prefirmadas de MinIO
   * (secureUrl/expiresIn) porque expiran y quedarían obsoletas en el cache.
   */
  buildProfileSnapshot(
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
      // La pantalla "Identidad y firma" decide qué mostrar con estos campos, y se hidrata desde
      // este snapshot. `UpdateSigningCredentialStatusUseCase` borra la key de Redis al cambiar
      // el estado, para que la siguiente lectura lo reconstruya desde Postgres.
      signingCredentialStatus: user.signingCredentialStatus,
      // Derivada del estado, no una columna: el frontend la usa para el caso binario "¿ya puede
      // firmar?" sin comparar contra el enum.
      signingCredentialConfigured:
        user.signingCredentialStatus ===
        SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED,
      identityVerifiedAt: user.identityVerifiedAt,
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
  async refreshCurpCache(
    user: UserEntity,
    personalInformation: PersonalInformationEntity,
  ): Promise<void> {
    try {
      const payload = this.buildProfileSnapshot(user, personalInformation);
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
   * Snapshot del perfil cacheado en Redis DB 0 bajo la key del CURP, o `null` si no hay nada
   * guardado. Devolver `null` en vez de reconstruirlo es lo que permite que quien llama decida
   * qué hacer con un cache frío.
   */
  async readCachedProfile(curp: string): Promise<unknown | null> {
    const raw = await this.redisService.get(curp);

    return raw ? JSON.parse(raw) : null;
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

    await this.refreshCurpCache(user, user.personalInformation);
  }

  /**
   * Escribe los campos de información personal y devuelve la fila ya actualizada. El refresco
   * del cache no ocurre acá: lo dispara quien coordina la operación, que es el que sabe si
   * además cambió algo más del usuario.
   */
  async savePersonalInformation(
    personalInformationId: string,
    dto: UpdatePersonalInformationDto,
  ): Promise<PersonalInformationEntity> {
    await this.personalInformationRepository.update(personalInformationId, {
      ...dto,
    });

    return this.personalInformationRepository.findOne({
      where: { id: personalInformationId },
    });
  }

  /**
   * Si algún registro de información personal ya usa ese RFC. Se normaliza a mayúsculas porque
   * la columna guarda el RFC en su forma canónica y una consulta en minúsculas no encontraría
   * nada.
   */
  async isRfcRegistered(rfc: string): Promise<boolean> {
    const existing = await this.personalInformationRepository.findOne({
      where: { rfc: rfc.toUpperCase() },
    });

    return !!existing;
  }

  /** Lanza ConflictException si otro usuario activo ya tiene ese CURP registrado. */
  async assertCurpNotTaken(curp: string): Promise<void> {
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
  async assertRfcNotTaken(rfc: string): Promise<void> {
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

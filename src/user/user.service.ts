// External dependencies
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

// DTOs
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdatePersonalInformationDto } from './dto/update-personal-information.dto';

// Entities
import { UserEntity } from './entities/user.entity';
import { PersonalInformationEntity } from './entities/personal-information.entity';

// Enums
import { UserRoles } from './enums/user-roles';

// Interfaces
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { SignatureService } from 'src/signature/signature.service';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(PersonalInformationEntity)
    private personalInformationRepository: Repository<PersonalInformationEntity>,

    private signatureService: SignatureService,
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

    const personalInformation = await this.personalInformationRepository.save(
      this.personalInformationRepository.create({
        name: createUserDto.firstName?.toUpperCase(),
        lastName: createUserDto.lastName?.toUpperCase(),
        curp: createUserDto.nationalId?.toUpperCase(),
      }),
    );

    const user = this.userRepository.create({
      ...(createUserDto.firstName && {
        firstName: createUserDto.firstName.toUpperCase(),
      }),
      ...(createUserDto.lastName && {
        lastName: createUserDto.lastName.toUpperCase(),
      }),
      ...(createUserDto.email && { email: createUserDto.email.toLowerCase() }),
      ...(createUserDto.position && {
        position: createUserDto.position.toUpperCase(),
      }),
      roles: createUserDto.roles ?? [UserRoles.SIGNER],
      ...(createUserDto.nationalId && {
        nationalId: createUserDto.nationalId.toUpperCase(),
      }),
      personalInformationId: personalInformation.id,
    });

    const newUser = await this.userRepository.save(user);

    return {
      success: true,
      message: 'Usuario creado correctamente',
      data: this.removeSensitiveData(newUser),
    };
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
      signatureId,
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

    const personalInformation = await this.personalInformationRepository.save(
      this.personalInformationRepository.create({
        name: dto.firstName.toUpperCase(),
        lastName: dto.lastName.toUpperCase(),
        curp: dto.nationalId.toUpperCase(),
      }),
    );

    const user = this.userRepository.create({
      firstName: dto.firstName.toUpperCase(),
      lastName: dto.lastName.toUpperCase(),
      email: dto.email.toLowerCase(),
      position: dto.position.toUpperCase(),
      roles: [UserRoles.SIGNER],
      nationalId: dto.nationalId.toUpperCase(),
      password: hashedPassword,
      personalInformationId: personalInformation.id,
    });

    const newUser = await this.userRepository.save(user);

    return {
      success: true,
      message: 'Usuario registrado correctamente',
      data: this.removeSensitiveData(newUser),
    };
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
}

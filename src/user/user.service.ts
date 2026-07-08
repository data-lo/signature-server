// External dependencies
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

// DTOs
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

// Entities
import { UserEntity } from './entities/user.entity';

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

    private signatureService: SignatureService
  ) { }

  async create(createUserDto: CreateUserDto): Promise<BaseResponse<UserEntity>> {
    const existingUser = await this.userRepository.findOne({
      where: { email: createUserDto.email.toLowerCase() }
    });
    if (existingUser) {
      throw new ConflictException('Ya existe un usuario registrado con ese correo electrónico');
    }

    const user = this.userRepository.create({
      ...(createUserDto.firstName && { firstName: createUserDto.firstName.toUpperCase() }),
      ...(createUserDto.lastName && { lastName: createUserDto.lastName.toUpperCase() }),
      ...(createUserDto.email && { email: createUserDto.email.toLowerCase() }),
      ...(createUserDto.position && { position: createUserDto.position.toUpperCase() }),
      roles: createUserDto.roles ?? [UserRoles.SIGNER],
      ...(createUserDto.nationalId && { nationalId: createUserDto.nationalId.toUpperCase() }),
    });

    const newUser = await this.userRepository.save(user);

    return {
      success: true,
      message: 'Usuario creado correctamente',
      data: this.removeSensitiveData(newUser),
    };
  }

  async findAllActiveUsers(withSignature = false): Promise<BaseResponse<UserEntity[]>> {
    const users = await this.userRepository.find({
      where: { isActive: true },
      ...(withSignature && {
        relations: { signature: true },
        select: {
          signature: {
            id: true,
            signatureObjectKey: true
          }
        }
      })
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
        const sanitizedUser = this.removeSensitiveData(user);

        if (withSignature && user.signature?.signatureObjectKey) {
          const signature = await this.signatureService.getFile(
            user.signature.signatureObjectKey,
            BUCKET_TYPES_ENUM.SIGNATURE_IMAGES
          );

          return {
            ...sanitizedUser,
            signature: {
              id: user.signature.id,
              secureUrl: signature.secureUrl,
              expiresIn: signature.expiresIn,
            }
          };
        }
        return sanitizedUser;
      })
    );

    return {
      success: true,
      message: 'Usuarios obtenidos correctamente',
      data: secureUsers as any,
    };
  }

  async findOneActiveUser(id: string, withSignature = false): Promise<BaseResponse<UserEntity | null>> {
    const user = await this.userRepository.findOne({
      where: { id, isActive: true },
      ...(withSignature && {
        relations: {
          signature: true
        },
        select: {
          signature: {
            id: true,
            signatureObjectKey: true,
            officialCardObjectKey: true,
          }
        }
      })
    });

    if (!user) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
    }

    let signature;
    let officialFile;

    const sanitizedUser = this.removeSensitiveData(user);

    if (withSignature && user.signature?.signatureObjectKey) {
      signature = await this.signatureService.getFile(
        user.signature.signatureObjectKey,
        BUCKET_TYPES_ENUM.SIGNATURE_IMAGES
      );
    }

    if (withSignature && user.signature?.officialCardObjectKey) {
      officialFile = await this.signatureService.getFile(
        user.signature.officialCardObjectKey,
        BUCKET_TYPES_ENUM.OFICIAL_CARDS
      );
    }

    const newUserObject = {
      ...sanitizedUser,
      ...(withSignature && user.signature?.signatureObjectKey && {
        signature: {
          id: user.signature.id,
          secureUrl: signature.secureUrl,
          expiresIn: signature.expiresIn
        }
      }),
      ...(withSignature && user.signature?.officialCardObjectKey && {
        officialFile: {
          id: user.signature.id,
          secureUrl: officialFile.secureUrl,
          expiresIn: officialFile.expiresIn
        }
      })
    };

    return {
      success: true,
      message: 'Usuario obtenido correctamente',
      data: newUserObject as any,
    };
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<BaseResponse<any>> {
    await this.userRepository.update(id, {
      ...(updateUserDto.firstName && { firstName: updateUserDto.firstName.toUpperCase() }),
      ...(updateUserDto.lastName && { lastName: updateUserDto.lastName.toUpperCase() }),
      ...(updateUserDto.email && { email: updateUserDto.email.toLowerCase() }),
      ...(updateUserDto.position && { position: updateUserDto.position.toUpperCase() }),
      ...(updateUserDto.roles && { roles: updateUserDto.roles }),
      ...(updateUserDto.nationalId && { nationalId: updateUserDto.nationalId.toUpperCase() }),
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
      { isDeleted: true, isActive: false }
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
  private removeSensitiveData(user: UserEntity | UserEntity[]): UserEntity | UserEntity[] {
    const strip = ({ signatureId, createdAt, updatedAt, isActive, isDeleted, password, ...safeUser }: UserEntity) => safeUser as UserEntity;

    return Array.isArray(user) ? user.map(strip) : strip(user);
  }

  sanitize(user: UserEntity): UserEntity {
    return this.removeSensitiveData(user);
  }

  async createFromSignup(
    dto: { firstName: string; lastName: string; email: string; position: string; nationalId: string },
    hashedPassword: string,
  ): Promise<BaseResponse<UserEntity>> {
    const existingUser = await this.userRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });
    if (existingUser) {
      throw new ConflictException('Ya existe un usuario registrado con ese correo electrónico');
    }

    const user = this.userRepository.create({
      firstName: dto.firstName.toUpperCase(),
      lastName: dto.lastName.toUpperCase(),
      email: dto.email.toLowerCase(),
      position: dto.position.toUpperCase(),
      roles: [UserRoles.SIGNER],
      nationalId: dto.nationalId.toUpperCase(),
      password: hashedPassword,
    });

    const newUser = await this.userRepository.save(user);

    return {
      success: true,
      message: 'Usuario registrado correctamente',
      data: this.removeSensitiveData(newUser),
    };
  }
}

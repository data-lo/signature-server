import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserEntity } from './entities/user.entity';
import { SignatureService } from 'src/signature/signature.service';
import { NotFoundError } from 'rxjs';
import { UserRoles } from './enums/user-roles';
import { ApiResponseDto } from 'src/interfaces/api-response.dto';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private signatureService: SignatureService
  ) { }

  async create(createUserDto: CreateUserDto): Promise<UserEntity> {
    const { firstName, lastName, email, position, roles, nationalId } = createUserDto;

    const user = this.userRepository.create({
      firstName: firstName.toUpperCase(),
      lastName: lastName.toUpperCase(),
      email: email.toLowerCase(),
      position: position.toUpperCase(),
      roles: roles ?? [UserRoles.SIGNER],
      nationalId: nationalId.toUpperCase(),
    });

    const new_user = await this.userRepository.save(user);

    return this.removeSensitiveData(new_user);
  }

  async findAllActiveUsers(): Promise<UserEntity[]> {
    const users = await this.userRepository.find({
      where: { isActive: true },
    });
    if (!users || users.length === 0) {
      return [];
    }
    const secure_users = [];
    users.forEach(user => {
      const secure_user = this.removeSensitiveData(user);
      secure_users.push(secure_user);
    });
    return secure_users;
  }

  async findOneActiveUser(id: string): Promise<UserEntity | null> {
    const user = await this.userRepository.findOne({
      where: { id, isActive: true },
    });

    if (!user) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
    }

    return this.removeSensitiveData(user);
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<UserEntity> {

    const dbUser = await this.userRepository.findOne({ where: { id } });

    const { position, roles, firstName, lastName, nationalId, email } = updateUserDto;

    await this.userRepository.update(id, {
      firstName: firstName ? firstName.toUpperCase() : dbUser.firstName,
      lastName: lastName ? lastName.toUpperCase() : dbUser.lastName,
      email: email ? email.toLowerCase() : dbUser.email,
      position: position ? position.toUpperCase() : dbUser.position,
      roles: roles,
      nationalId: nationalId ? nationalId.toUpperCase() : dbUser.nationalId,
    });

    return this.findOneActiveUser(id);
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


  async remove(id: string): Promise<ApiResponseDto> {
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
    const strip = ({ signatureId, createdAt, updatedAt, isActive, isDeleted, ...safeUser }: UserEntity) => safeUser as UserEntity;

    return Array.isArray(user) ? user.map(strip) : strip(user);
  }
}

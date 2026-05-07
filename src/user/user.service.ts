import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserEntity } from './entities/user.entity';
import { NotFoundError } from 'rxjs';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) { }

  async create(createUserDto: CreateUserDto): Promise<UserEntity> {
    const { firstName, lastName, email, position, rol, curp } = createUserDto;
    const user = this.userRepository.create({
      firstName: firstName.toUpperCase(),
      lastName: lastName.toUpperCase(),
      email: email.toLowerCase(),
      position: position ? position.toUpperCase() : null,
      roles: rol != null ? rol : ['signer'],
      nationalId: curp.toUpperCase(),
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

  async findOneActiveUser(id: string): Promise<UserEntity> {
    const user = await this.userRepository.findOne({
      where: { id, isActive: true },
    });
    if (!user) {
      return null;
    }
    return this.removeSensitiveData(user);
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<UserEntity> {

    const dbUser = await this.userRepository.findOne({ where: { id } });
    console.log(dbUser);
    console.log('Updating user with data:', updateUserDto);
    const { position, rol, firstName, lastName, curp, email } = updateUserDto;

    console.log(rol);
    await this.userRepository.update(id, {
      firstName: firstName ? firstName.toUpperCase() : dbUser.firstName,
      lastName: lastName ? lastName.toUpperCase() : dbUser.lastName,
      email: email ? email.toLowerCase() : dbUser.email,
      position: position ? position.toUpperCase() : dbUser.position,
      roles: rol ? rol : dbUser.roles,
      nationalId: curp ? curp.toUpperCase() : dbUser.nationalId,
    })
    return this.findOneActiveUser(id);
  }

  async findOne(id: string): Promise<UserEntity> {
    const user = await this.userRepository.findOne({where:{id}});
    if(!user){
      throw new Error('Usuario no encontrado');
    }
    if(!user.isActive){
      throw new Error('Usuario no activo, no asignar a firmas');
    }
    return user;
  }

  async findOneByEmail(email: string): Promise<UserEntity> {
    return this.userRepository.findOne({ where: { email, isDeleted: false } });
  }

  async remove(id: string): Promise<string> {
    await this.userRepository.update(id, { isDeleted: true, isActive: false });
    return 'User deleted';
  }

  private removeSensitiveData(user: UserEntity): UserEntity {
    const { signatureId, createdAt, updatedAt, ...safeUser } = user;
    return safeUser as UserEntity;
  };
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserEntity } from './entities/user.entity';
import { NotFoundError } from 'rxjs';
import { LogService } from 'src/log/log.service';
import { shortUuid } from 'src/common/utils/short-uuid.util';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private readonly logService: LogService,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<UserEntity> {
    const traceId = shortUuid();
    void this.logService.write(`[User] create - [${traceId}]`);
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
    void this.logService.write(`[User] create - exito [${traceId}]`);
    return this.removeSensitiveData(new_user);
  }

  async findAllActiveUsers(): Promise<UserEntity[]> {
    const traceId = shortUuid();
    void this.logService.write(`[User] findAllActiveUsers - [${traceId}]`);
    const users = await this.userRepository.find({
      where: { isActive: true },
    });
    if (!users || users.length === 0) {
      void this.logService.write(`[User] findAllActiveUsers - exito [${traceId}]`);
      return [];
    }
    const secure_users = [];
    users.forEach(user => {
      const secure_user = this.removeSensitiveData(user);
      secure_users.push(secure_user);
    });
    void this.logService.write(`[User] findAllActiveUsers - exito [${traceId}]`);
    return secure_users;
  }

  async findOneActiveUser(id: string): Promise<UserEntity> {
    const traceId = shortUuid();
    void this.logService.write(`[User] findOneActiveUser - [${traceId}]`);
    const user = await this.userRepository.findOne({
      where: { id, isActive: true },
    });
    if (!user) {
      void this.logService.write(`[User] findOneActiveUser - exito usuario no encontrado [${traceId}]`);
      return null;
    }
    void this.logService.write(`[User] findOneActiveUser - exito [${traceId}]`);
    return this.removeSensitiveData(user);
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<UserEntity> {
    const traceId = shortUuid();
    void this.logService.write(`[User] update - [${traceId}]`);
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
    });
    void this.logService.write(`[User] update - exito [${traceId}]`);
    return this.findOneActiveUser(id);
  }

  async findOne(id: string): Promise<UserEntity> {
    const traceId = shortUuid();
    void this.logService.write(`[User] findOne - [${traceId}]`);
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      void this.logService.write(`[User] findOne - error usuario no encontrado [${traceId}]`);
      throw new Error('Usuario no encontrado');
    }
    if (!user.isActive) {
      void this.logService.write(`[User] findOne - error usuario no activo [${traceId}]`);
      throw new Error('Usuario no activo, no asignar a firmas');
    }
    void this.logService.write(`[User] findOne - exito [${traceId}]`);
    return user;
  }

  async findOneByEmail(email: string): Promise<UserEntity> {
    const traceId = shortUuid();
    void this.logService.write(`[User] findOneByEmail - [${traceId}]`);
    const result = await this.userRepository.findOne({ where: { email, isDeleted: false } });
    void this.logService.write(`[User] findOneByEmail - exito [${traceId}]`);
    return result;
  }

  async remove(id: string): Promise<string> {
    const traceId = shortUuid();
    void this.logService.write(`[User] remove - [${traceId}]`);
    await this.userRepository.update(id, { isDeleted: true, isActive: false });
    void this.logService.write(`[User] remove - exito [${traceId}]`);
    return 'User deleted';
  }

  private removeSensitiveData(user: UserEntity): UserEntity {
    const { signatureId, createdAt, updatedAt, ...safeUser } = user;
    return safeUser as UserEntity;
  }
}

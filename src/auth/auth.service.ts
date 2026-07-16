import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { UserService } from '../user/user.service';
import { PasswordService } from '../shared/password/password.service';
import { RedisService } from '../shared/redis/redis.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { BaseResponse } from '../interfaces/api-response.dto';
import { UserEntity } from '../user/entities/user.entity';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly passwordService: PasswordService,
    private readonly redisService: RedisService,
  ) {}

  async register(dto: RegisterDto): Promise<BaseResponse<UserEntity>> {
    const hashedPassword = await this.passwordService.hash(dto.password);
    return this.userService.createFromSignup(dto, hashedPassword);
  }

  async login(
    dto: LoginDto,
  ): Promise<BaseResponse<{ user: UserEntity; token: string }>> {
    const user = await this.userService.findOneByEmail(dto.email.toLowerCase());
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const matches = await this.passwordService.compare(
      dto.password,
      user.password,
    );
    if (!matches) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      roles: user.roles,
      nationalId: user.nationalId,
      jti: randomUUID(),
    };
    const token = this.jwtService.sign(payload);

    return {
      success: true,
      message: 'Inicio de sesión exitoso',
      data: { user: this.userService.sanitize(user), token },
    };
  }

  async logout(payload: JwtPayload): Promise<BaseResponse<null>> {
    const ttl = payload.exp ? payload.exp - Math.floor(Date.now() / 1000) : 0;
    if (ttl > 0) {
      await this.redisService.set(`blacklist:${payload.jti}`, '1', ttl);
    }
    return {
      success: true,
      message: 'Sesión cerrada correctamente',
      data: null,
    };
  }

  async me(payload: JwtPayload) {
    return this.userService.findOneActiveUser(payload.sub, true);
  }
}

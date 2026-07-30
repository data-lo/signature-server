import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { IS_SKIP_JWT_KEY } from '../decorators/skip-jwt-auth.decorator';
import { RedisService } from '../../shared/redis/redis.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { tokenValidAfterKey } from '../utils/token-valid-after.util';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const skipJwt = this.reflector.getAllAndOverride<boolean>(IS_SKIP_JWT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic || skipJwt) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token de autenticación requerido');
    }

    const token = authHeader.slice('Bearer '.length);

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    const isBlacklisted = await this.redisService.exists(
      `blacklist:${payload.jti}`,
    );
    if (isBlacklisted) {
      throw new UnauthorizedException('La sesión ha sido cerrada');
    }

    // Invalidación en bloque (ver historia "Recuperación de Contraseña mediante Código de
    // Verificación OTP"): a diferencia del blacklist de arriba (un solo jti, escrito por
    // logout()), esta marca invalida CUALQUIER JWT emitido antes de cierto momento — no hay un
    // registro de jtis emitidos por usuario para poder blacklistearlos uno por uno, así que
    // resetPassword() simplemente fija "ahora" y cualquier token con iat anterior deja de servir.
    const validAfterRaw = await this.redisService.get(
      tokenValidAfterKey(payload.sub),
    );
    if (validAfterRaw && payload.iat && payload.iat < Number(validAfterRaw)) {
      throw new UnauthorizedException('La sesión ha sido cerrada');
    }

    request.user = payload;
    return true;
  }
}

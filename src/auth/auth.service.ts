import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';

import { RedisService } from '../shared/redis/redis.service';
import { UserEntity } from '../user/entities/user.entity';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { PasswordResetTokenPayload } from './interfaces/password-reset-token-payload.interface';
import { tokenValidAfterKey } from './utils/token-valid-after.util';

/**
 * TTL de la marca de invalidación de sesiones — solo necesita sobrevivir cualquier JWT vivo, no
 * depende de parsear JWT_EXPIRES_IN.
 */
const TOKEN_VALID_AFTER_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Cuánto dura un `resetToken` desde que se canjea el OTP hasta que hay que volver a pedirlo. */
const PASSWORD_RESET_TOKEN_EXPIRES_IN = '10m';

/**
 * Capacidades de sesión reutilizables: emitir y verificar los tokens que maneja la autenticación
 * y llevar el registro en Redis de qué tokens dejaron de servir.
 *
 * Acá no vive ningún flujo de endpoint —eso está en `applications/`—: son las piezas que varios
 * casos de uso comparten. `signJwtForUser`, por ejemplo, lo usan tanto el login como la
 * verificación del OTP de registro, porque en ambos el resultado es el mismo: una sesión nueva.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * JWT de sesión. `sub`/`roles`/`nationalId` salen de `UserEntity` y no de `AccountEntity`:
   * la cuenta es sólo una copia sincronizada de la credencial (decisión D6 del plan ER-V2), y
   * quien firma documentos es la persona.
   *
   * El `jti` es lo que hace posible cerrar una sesión concreta: sin identificador por token,
   * `logout` no tendría qué poner en la lista negra.
   */
  signJwtForUser(user: UserEntity): string {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      roles: user.roles,
      nationalId: user.nationalId,
      jti: randomUUID(),
    };

    return this.jwtService.sign(payload);
  }

  /**
   * Token de un solo paso para el cambio de contraseña. Lleva `purpose` porque va firmado con
   * el mismo secreto que los JWT de sesión: sin esa marca, un token de sesión cualquiera
   * serviría para cambiar la contraseña de su dueño sin conocerla.
   */
  signPasswordResetToken(userId: string): string {
    return this.jwtService.sign(
      { sub: userId, purpose: 'password_reset' } as PasswordResetTokenPayload,
      { expiresIn: PASSWORD_RESET_TOKEN_EXPIRES_IN },
    );
  }

  /**
   * Verifica firma, vigencia y propósito de un `resetToken`. Un token malformado, expirado o
   * emitido para otra cosa dan el mismo 401: distinguirlos sólo le serviría a quien está
   * probando tokens.
   */
  async verifyPasswordResetToken(
    token: string,
  ): Promise<PasswordResetTokenPayload> {
    let payload: PasswordResetTokenPayload;

    try {
      payload =
        await this.jwtService.verifyAsync<PasswordResetTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    if (payload.purpose !== 'password_reset') {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    return payload;
  }

  /**
   * Cierra una sesión concreta anotando su `jti` hasta que el propio token expire. El TTL sale
   * del `exp` del token: guardarlo más tiempo sería ocupar Redis con entradas que ya no puede
   * consultar nadie, porque el JWT vencido lo rechaza antes la verificación de firma.
   */
  async blacklistJwt(payload: JwtPayload): Promise<void> {
    const ttl = payload.exp ? payload.exp - Math.floor(Date.now() / 1000) : 0;

    if (ttl > 0) {
      await this.redisService.set(`blacklist:${payload.jti}`, '1', ttl);
    }
  }

  /**
   * Momento (epoch en segundos) a partir del cual son válidos los tokens de un usuario, o
   * `null` si nunca se invalidaron en bloque sus sesiones.
   */
  async getSessionsValidAfter(userId: string): Promise<number | null> {
    const raw = await this.redisService.get(tokenValidAfterKey(userId));

    return raw ? Number(raw) : null;
  }

  /**
   * Invalida de golpe todos los tokens ya emitidos para un usuario. No hay un registro de jtis
   * por usuario que permita listarlos y anotarlos uno a uno, así que se fija la marca a "ahora"
   * y `JwtAuthGuard` rechaza todo lo que tenga un `iat` anterior.
   */
  async invalidateSessionsFor(userId: string): Promise<void> {
    await this.redisService.set(
      tokenValidAfterKey(userId),
      String(Math.floor(Date.now() / 1000)),
      TOKEN_VALID_AFTER_TTL_SECONDS,
    );
  }
}

import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

import { RedisService } from 'src/common/redis/redis.service';

/** Una regla de frecuencia: a lo sumo `limit` eventos por ventana de `windowSeconds`. */
export interface RateLimitRule {
  /** Nombre corto del límite (va en la clave de Redis). */
  name: string;
  limit: number;
  windowSeconds: number;
}

/** Envíos del código de una invitación: uno por minuto… */
export const OTP_SEND_COOLDOWN: RateLimitRule = {
  name: 'otp-send-cooldown',
  limit: 1,
  windowSeconds: 60,
};
/** …y a lo sumo cinco por hora. */
export const OTP_SEND_HOURLY: RateLimitRule = {
  name: 'otp-send-hourly',
  limit: 5,
  windowSeconds: 60 * 60,
};
/** Códigos equivocados de una invitación: cinco cada 15 minutos; después hay que esperar. */
export const OTP_VERIFY_FAILURES: RateLimitRule = {
  name: 'otp-verify-failures',
  limit: 5,
  windowSeconds: 15 * 60,
};
/** Invitaciones nuevas por firmante (renovación pública o reenvío por integración): 1 cada 10 min… */
export const INVITATION_ISSUE_COOLDOWN: RateLimitRule = {
  name: 'invitation-issue-cooldown',
  limit: 1,
  windowSeconds: 10 * 60,
};
/** …y a lo sumo diez por día. */
export const INVITATION_ISSUE_DAILY: RateLimitRule = {
  name: 'invitation-issue-daily',
  limit: 10,
  windowSeconds: 24 * 60 * 60,
};

/** 429 con un mensaje genérico; no dice qué límite se alcanzó ni sobre qué. */
export class SigningRateLimitException extends HttpException {
  constructor() {
    super(
      'Demasiados intentos. Espera unos minutos antes de volver a intentarlo.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Límites de frecuencia de la firma pública y de las invitaciones, por sujeto (invitación o
 * colaborador) y no por IP: el throttle por IP de Nest ya existe, y éste cierra el abuso repartido
 * entre IPs contra una misma invitación.
 *
 * Los contadores viven en Redis con su ventana. Las claves llevan ids internos, nunca tokens.
 */
@Injectable()
export class SigningRateLimitService {
  constructor(private readonly redis: RedisService) {}

  /**
   * Cuenta un evento y lo rechaza si pasa del límite de alguna de las reglas.
   *
   * @param subject - Invitación o colaborador (`inv:<id>`, `collab:<id>`).
   * @param rules - Reglas que aplican; se cuentan todas.
   * @returns Nada.
   *
   * @throws {SigningRateLimitException} (429) Si alguna regla se excede.
   *
   * @example
   * ```ts
   * await limits.consume('inv:1', [OTP_SEND_COOLDOWN, OTP_SEND_HOURLY]);
   * ```
   */
  async consume(subject: string, rules: RateLimitRule[]): Promise<void> {
    const counts = await Promise.all(
      rules.map((rule) =>
        this.redis.incrementWithExpiry(
          this.key(rule, subject),
          rule.windowSeconds,
        ),
      ),
    );
    if (counts.some((count, index) => count > rules[index].limit)) {
      throw new SigningRateLimitException();
    }
  }

  /**
   * Rechaza si la regla ya se agotó, sin contar un evento nuevo. Para los intentos fallidos: se
   * revisa antes de validar el código y sólo se cuenta si falla.
   *
   * @param subject - Sujeto del límite.
   * @param rule - Regla.
   * @returns Nada.
   *
   * @throws {SigningRateLimitException} (429) Si ya se alcanzó el límite.
   *
   * @example
   * ```ts
   * await limits.assertAvailable('inv:1', OTP_VERIFY_FAILURES);
   * ```
   */
  async assertAvailable(subject: string, rule: RateLimitRule): Promise<void> {
    const current = Number(await this.redis.get(this.key(rule, subject)));
    if (current >= rule.limit) {
      throw new SigningRateLimitException();
    }
  }

  /**
   * Cuenta un evento sin rechazar (p. ej. un código equivocado, que ya respondió su propio error).
   *
   * @param subject - Sujeto del límite.
   * @param rule - Regla.
   * @returns El conteo dentro de la ventana.
   *
   * @throws Errores de conexión de Redis.
   *
   * @example
   * ```ts
   * await limits.record('inv:1', OTP_VERIFY_FAILURES);
   * ```
   */
  record(subject: string, rule: RateLimitRule): Promise<number> {
    return this.redis.incrementWithExpiry(
      this.key(rule, subject),
      rule.windowSeconds,
    );
  }

  /**
   * Reinicia un contador (p. ej. los fallos, al validar bien el código).
   *
   * @param subject - Sujeto del límite.
   * @param rule - Regla.
   * @returns Nada.
   *
   * @throws Errores de conexión de Redis.
   *
   * @example
   * ```ts
   * await limits.reset('inv:1', OTP_VERIFY_FAILURES);
   * ```
   */
  async reset(subject: string, rule: RateLimitRule): Promise<void> {
    await this.redis.del(this.key(rule, subject));
  }

  private key(rule: RateLimitRule, subject: string): string {
    return `signing-rate:${rule.name}:${subject}`;
  }
}

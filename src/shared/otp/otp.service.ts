import { TOTP } from 'otplib';
import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class OtpService {
  private readonly totp: TOTP;
  private readonly OTP_TTL = 900;
  private readonly KEY_PREFIX = 'otp:';

  constructor(private readonly redisService: RedisService) {
    // Las opciones se pasan en el constructor; no se pueden asignar después porque son read-only
    this.totp = new TOTP({ digits: 6, period: 900 });
  }

  /**
   * Genera un código OTP de 6 dígitos usando otplib y lo almacena en Redis con TTL de 15 minutos.
   * Se guarda el CÓDIGO (no el secreto) para que la expiración dependa únicamente del TTL de Redis,
   * evitando que la ventana de tiempo interna de TOTP cause fallos prematuros.
   * Retorna el código que debe enviarse al usuario por correo.
   */
  async generateAndStore(userId: string): Promise<string> {
    const secret = this.totp.generateSecret();
    const code = await this.totp.generate({ secret });
    // Guardamos el código generado, no el secreto: verificación por comparación directa
    await this.redisService.set(`${this.KEY_PREFIX}${userId}`, code, this.OTP_TTL);
    return code;
  }

  /**
   * Verifica si el token ingresado por el usuario coincide con el código almacenado en Redis.
   * Si el código no existe en Redis significa que expiró (pasaron los 15 minutos).
   * Si es correcto, elimina el código de Redis para que sea de uso único.
   * Retorna true si el token es válido, false si expiró o no coincide.
   */
  async verify(userId: string, token: string): Promise<boolean> {
    const storedCode = await this.redisService.get(`${this.KEY_PREFIX}${userId}`);
    if (!storedCode) return false;
    const isValid = storedCode === token;
    if (isValid) {
      await this.redisService.del(`${this.KEY_PREFIX}${userId}`);
    }
    return isValid;
  }

  /**
   * Invalida manualmente el OTP activo de un usuario eliminando su código de Redis.
   * Útil para cancelar un proceso de verificación o forzar la generación de un nuevo código.
   */
  async revoke(userId: string): Promise<void> {
    await this.redisService.del(`${this.KEY_PREFIX}${userId}`);
  }

  /**
   * Verifica si el usuario tiene un OTP activo (código presente en Redis).
   * Retorna true si existe un OTP pendiente de verificación, false si ya expiró o no se generó.
   */
  async hasActive(userId: string): Promise<boolean> {
    return (await this.redisService.exists(`${this.KEY_PREFIX}${userId}`)) > 0;
  }
}

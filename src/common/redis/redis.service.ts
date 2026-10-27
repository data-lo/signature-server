import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis;

  /**
   * Se ejecuta automáticamente al iniciar el módulo.
   * Crea la conexión con Redis usando las variables de entorno configuradas.
   */
  onModuleInit() {
    this.client = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
      password: process.env.REDIS_PASSWORD,
    });
  }

  /**
   * Guarda un valor en Redis bajo la clave indicada.
   * Si se proporciona expireSeconds, la clave se elimina automáticamente al expirar el tiempo.
   */
  async set(key: string, value: string, expireSeconds?: number): Promise<'OK'> {
    if (expireSeconds) {
      return this.client.set(key, value, 'EX', expireSeconds);
    }
    return this.client.set(key, value);
  }

  /**
   * Guarda un valor sólo si la clave no existe (`SET NX EX`), de forma atómica.
   *
   * @param key - Clave.
   * @param value - Valor.
   * @param expireSeconds - Vigencia de la clave.
   * @returns `true` si la guardó; `false` si ya existía.
   *
   * @throws Errores de conexión de Redis.
   *
   * @example
   * ```ts
   * await redis.setIfAbsent('lock:x', 'PROCESSING', 600); // true la primera vez
   * ```
   */
  async setIfAbsent(
    key: string,
    value: string,
    expireSeconds: number,
  ): Promise<boolean> {
    const result = await this.client.set(key, value, 'EX', expireSeconds, 'NX');
    return result === 'OK';
  }

  /**
   * Incrementa un contador y, si es nuevo, le pone vigencia; las dos cosas en una transacción.
   *
   * @param key - Clave del contador.
   * @param expireSeconds - Vigencia de la ventana; sólo se aplica al crear el contador.
   * @returns El valor del contador después de incrementarlo.
   *
   * @throws Errores de conexión de Redis.
   *
   * @example
   * ```ts
   * await redis.incrementWithExpiry('otp-sends:inv-1', 3600); // 1, 2, 3…
   * ```
   */
  async incrementWithExpiry(
    key: string,
    expireSeconds: number,
  ): Promise<number> {
    const results = await this.client
      .multi()
      .incr(key)
      .expire(key, expireSeconds, 'NX')
      .exec();
    return Number(results?.[0]?.[1] ?? 0);
  }

  /**
   * Obtiene el valor almacenado bajo la clave indicada.
   * Retorna null si la clave no existe o ya expiró.
   */
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /**
   * Elimina una o más claves de Redis.
   * Retorna el número de claves que fueron eliminadas.
   */
  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  /**
   * Verifica si una clave existe en Redis.
   * Retorna 1 si existe, 0 si no existe o ya expiró.
   */
  async exists(key: string): Promise<number> {
    return this.client.exists(key);
  }

  /**
   * Se ejecuta automáticamente al detener el módulo.
   * Cierra la conexión con Redis para liberar recursos.
   */
  async ping(): Promise<string> {
    return this.client.ping();
  }

  onModuleDestroy() {
    if (this.client) {
      this.client.disconnect();
    }
  }
}

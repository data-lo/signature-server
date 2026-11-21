import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Valores efectivos del worker de sellado. */
export interface SealingWorkerSettings {
  /** `SEALING_WORKER_ENABLED`: si el cron reclama trabajos. Apagarlo no pierde pendientes. */
  enabled: boolean;
  /** `SEALING_BATCH_SIZE`: trabajos como máximo por pasada del cron. */
  batchSize: number;
  /** `SEALING_CONCURRENCY`: trabajos en paralelo dentro de una instancia. */
  concurrency: number;
  /** `SEALING_MAX_ATTEMPTS`: ejecuciones totales, incluida la primera. */
  maxAttempts: number;
  /** `SEALING_LEASE_SECONDS`: duración de un reclamo. */
  leaseSeconds: number;
  /** `SEALING_HEARTBEAT_SECONDS`: cada cuánto se renueva el reclamo de un trabajo en curso. */
  heartbeatSeconds: number;
}

/** Valores por omisión, los mismos que `.env.example`. */
export const DEFAULT_SEALING_WORKER_SETTINGS: SealingWorkerSettings = {
  enabled: false,
  batchSize: 10,
  concurrency: 2,
  maxAttempts: 8,
  leaseSeconds: 120,
  heartbeatSeconds: 30,
};

/**
 * Lee y valida la configuración del worker de sellado.
 *
 * Un valor inválido detiene el arranque en vez de caer a un valor por omisión: un
 * `SEALING_LEASE_SECONDS=12O` silencioso dejaría reclamos de 120 s cuando se quería otra cosa, o
 * un heartbeat más lento que el lease, que haría que otra instancia robe trabajos en curso.
 *
 * @param read - Lector de variables (normalmente `ConfigService.get`).
 * @returns La configuración validada.
 *
 * @throws {Error} Si una variable no es un entero positivo, `SEALING_WORKER_ENABLED` no es
 *   `true`/`false`, o el heartbeat no es menor que el lease.
 *
 * @example
 * ```ts
 * const settings = parseSealingWorkerSettings((key) => process.env[key]);
 * settings.maxAttempts; // 8
 * ```
 */
export function parseSealingWorkerSettings(
  read: (key: string) => string | undefined,
): SealingWorkerSettings {
  const settings: SealingWorkerSettings = {
    enabled: parseBoolean(
      'SEALING_WORKER_ENABLED',
      read('SEALING_WORKER_ENABLED'),
      DEFAULT_SEALING_WORKER_SETTINGS.enabled,
    ),
    batchSize: parsePositiveInteger(
      'SEALING_BATCH_SIZE',
      read('SEALING_BATCH_SIZE'),
      DEFAULT_SEALING_WORKER_SETTINGS.batchSize,
    ),
    concurrency: parsePositiveInteger(
      'SEALING_CONCURRENCY',
      read('SEALING_CONCURRENCY'),
      DEFAULT_SEALING_WORKER_SETTINGS.concurrency,
    ),
    maxAttempts: parsePositiveInteger(
      'SEALING_MAX_ATTEMPTS',
      read('SEALING_MAX_ATTEMPTS'),
      DEFAULT_SEALING_WORKER_SETTINGS.maxAttempts,
    ),
    leaseSeconds: parsePositiveInteger(
      'SEALING_LEASE_SECONDS',
      read('SEALING_LEASE_SECONDS'),
      DEFAULT_SEALING_WORKER_SETTINGS.leaseSeconds,
    ),
    heartbeatSeconds: parsePositiveInteger(
      'SEALING_HEARTBEAT_SECONDS',
      read('SEALING_HEARTBEAT_SECONDS'),
      DEFAULT_SEALING_WORKER_SETTINGS.heartbeatSeconds,
    ),
  };

  if (settings.heartbeatSeconds >= settings.leaseSeconds) {
    throw new Error(
      `SEALING_HEARTBEAT_SECONDS (${settings.heartbeatSeconds}) debe ser menor que SEALING_LEASE_SECONDS (${settings.leaseSeconds}).`,
    );
  }

  return settings;
}

/**
 * Configuración del worker de sellado como provider de Nest, validada al construirse (al arrancar).
 */
@Injectable()
export class SealingWorkerConfig {
  readonly settings: SealingWorkerSettings;

  constructor(configService: ConfigService) {
    this.settings = parseSealingWorkerSettings((key) =>
      configService.get<string>(key),
    );
  }
}

/**
 * Entero positivo de una variable de entorno.
 *
 * @param name - Nombre de la variable, para el mensaje.
 * @param raw - Valor crudo.
 * @param fallback - Valor si no está definida o está vacía.
 * @returns El entero.
 *
 * @throws {Error} Si no es un entero mayor que cero.
 *
 * @example
 * ```ts
 * parsePositiveInteger('SEALING_BATCH_SIZE', '10', 10); // 10
 * ```
 */
function parsePositiveInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) {
    throw new Error(
      `${name} debe ser un entero mayor que cero (recibido "${raw}").`,
    );
  }
  return Number(raw);
}

/**
 * Booleano estricto de una variable de entorno.
 *
 * @param name - Nombre de la variable, para el mensaje.
 * @param raw - Valor crudo.
 * @param fallback - Valor si no está definida o está vacía.
 * @returns `true` o `false`.
 *
 * @throws {Error} Si no es `true` ni `false`.
 *
 * @example
 * ```ts
 * parseBoolean('SEALING_WORKER_ENABLED', 'true', false); // true
 * ```
 */
function parseBoolean(
  name: string,
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = raw.trim().toLowerCase();
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${name} debe ser "true" o "false" (recibido "${raw}").`);
  }
  return value === 'true';
}

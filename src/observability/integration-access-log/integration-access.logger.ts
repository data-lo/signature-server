import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  INTEGRATION_ACCESS_OUTCOME_ENUM,
  IntegrationAccessLogEvent,
} from './integration-access-log.interface';

/** Token para reemplazar el destino de las líneas (por defecto, `process.stdout`). */
export const INTEGRATION_ACCESS_LOG_WRITER = Symbol(
  'INTEGRATION_ACCESS_LOG_WRITER',
);

/** Escribe una línea ya serializada, sin salto final. */
export type IntegrationAccessLogWriter = (line: string) => void;

/** Nivel de cada línea, para que el agregador de logs pueda filtrar sin leer `outcome`. */
export type IntegrationAccessLogLevel = 'info' | 'warn' | 'error';

/**
 * Destino por defecto: una línea por evento en la salida estándar.
 *
 * @param line - Evento ya serializado.
 * @returns Nada.
 *
 * @example
 * ```ts
 * stdoutIntegrationAccessLogWriter('{"event":"integration.http_request"}');
 * ```
 */
export function stdoutIntegrationAccessLogWriter(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Logger dedicado del evento `integration.http_request`: una línea JSON por evento en la salida
 * estándar, con `timestamp` y `level` delante de los campos del evento.
 *
 * Va aparte del `ConsoleLogger` de Nest, que escribe texto con colores y contexto: un agregador
 * (Loki, CloudWatch, Datadog…) puede parsear esta línea sin expresiones regulares. No reemplaza
 * los `new Logger()` existentes.
 */
@Injectable()
export class IntegrationAccessLogger {
  private readonly write: IntegrationAccessLogWriter;

  constructor(
    @Optional()
    @Inject(INTEGRATION_ACCESS_LOG_WRITER)
    writer?: IntegrationAccessLogWriter,
  ) {
    this.write = writer ?? stdoutIntegrationAccessLogWriter;
  }

  /**
   * Escribe el evento. Nunca lanza: un fallo al escribir el log no debe afectar a la petición ni,
   * como corre en el `close` de la respuesta, tumbar el proceso.
   *
   * @param event - Evento ya saneado (`buildIntegrationAccessLogEvent`).
   * @returns Nada.
   *
   * @example
   * ```ts
   * accessLogger.log(buildIntegrationAccessLogEvent(input));
   * // {"timestamp":"2026-11-14T18:00:00.000Z","level":"info","event":"integration.http_request",…}
   * ```
   */
  log(event: IntegrationAccessLogEvent): void {
    try {
      this.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: levelOf(event.outcome),
          ...event,
        }),
      );
    } catch {
      // Sin destino para el log no hay a dónde reportar el fallo.
    }
  }
}

/**
 * Nivel de una línea según el resultado: los 5xx son `error`, los cortes del cliente `warn` y el
 * resto —éxitos y 4xx, que son el cliente equivocándose— `info`.
 *
 * @param outcome - Resultado de la petición.
 * @returns El nivel.
 *
 * @example
 * ```ts
 * levelOf(INTEGRATION_ACCESS_OUTCOME_ENUM.SERVER_ERROR); // 'error'
 * ```
 */
export function levelOf(
  outcome: INTEGRATION_ACCESS_OUTCOME_ENUM,
): IntegrationAccessLogLevel {
  if (outcome === INTEGRATION_ACCESS_OUTCOME_ENUM.SERVER_ERROR) return 'error';
  if (outcome === INTEGRATION_ACCESS_OUTCOME_ENUM.CLIENT_CLOSED) return 'warn';
  return 'info';
}

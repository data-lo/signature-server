import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { ReleaseExpiredCreditReservationsUseCase } from './release-expired-credit-reservations.use-case';

/**
 * Programa la liberación de reservas de créditos vencidas o huérfanas.
 *
 * Cada cinco minutos y sin solapar pasadas (`waitForCompletion`). Con varias instancias corriendo
 * a la vez no hay doble liberación: el caso de uso es idempotente. `ScheduleModule.forRoot()` vive
 * en `WebhooksModule` y descubre este `@Cron` en cualquier módulo.
 */
@Injectable()
export class ReleaseExpiredCreditReservationsJob {
  private readonly logger = new Logger(
    ReleaseExpiredCreditReservationsJob.name,
  );

  constructor(
    private readonly releaseExpired: ReleaseExpiredCreditReservationsUseCase,
  ) {}

  /**
   * Ejecuta una pasada; los errores se registran y no tumban el scheduler.
   *
   * @returns Nada.
   *
   * @example
   * ```ts
   * await job.run();
   * ```
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { waitForCompletion: true })
  async run(): Promise<void> {
    try {
      await this.releaseExpired.execute();
    } catch (error) {
      this.logger.error(
        'Falló la liberación programada de reservas de créditos.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}

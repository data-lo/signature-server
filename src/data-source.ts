import { config } from 'dotenv';
import { DataSource } from 'typeorm';

config();

// DataSource independiente para la CLI de TypeORM (migration:generate/run/revert).
// La app en sí sigue usando TypeOrmModule.forRootAsync en app.module.ts.
export default new DataSource({
  type: 'postgres',
  url: process.env.POSTGRES_DB_URL,
  entities: [__dirname + '/**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  /**
   * Una transacción POR migración, no una para toda la tanda.
   *
   * No es una preferencia: `AddFreeBillingProfileStatus` tiene que confirmar el valor nuevo del
   * enum antes de que la migración siguiente pueda escribirlo (Postgres 55P04), y para eso
   * declara `transaction = false`. Con el modo por defecto (`all`) TypeORM rechaza ese override
   * de plano —"Migrations ... override the transaction mode, but the global transaction mode is
   * all"— y no corre ninguna migración.
   *
   * Lo que se pierde es que un fallo a mitad de tanda ya no revierte las migraciones anteriores.
   * A cambio, cada una queda registrada en `migrations` al confirmar, así que volver a lanzar el
   * comando retoma donde se quedó en vez de repetir lo ya aplicado.
   */
  migrationsTransactionMode: 'each',
});

import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { join } from 'path';
import { DataSource } from 'typeorm';

dotenv.config();

/**
 * Adopta el sistema de migraciones en una base cuyo esquema ya existe, marcando como aplicadas las
 * migraciones pendientes SIN ejecutarlas.
 *
 * Hace falta una sola vez por entorno. Mientras la aplicación arrancó con `synchronize: true`, el
 * esquema se derivaba de las entidades y la tabla `migrations` se quedó atrás: al pasar a
 * `synchronize: false` + `migrationsRun: true`, esas pendientes intentan crear objetos que ya
 * existen y el arranque falla con `column "..." already exists`. Registrarlas sin correrlas alinea
 * el historial con la realidad y deja que, de ahí en adelante, sólo se apliquen las nuevas.
 *
 * **Sólo es correcto si el esquema ya está al día con las entidades**, que es justo lo que
 * garantizaba `synchronize`. Contra una base a medio construir dejaría cambios reales sin aplicar,
 * así que exige `--confirm` y nunca corre solo.
 *
 * Uso:
 *   npm run migration:baseline -- --confirm
 */
async function main(): Promise<void> {
  const confirmed = process.argv.includes('--confirm');

  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.POSTGRES_DB_URL,
    entities: [join(__dirname, '..', '**', '*.entity{.ts,.js}')],
    migrations: [join(__dirname, '..', 'migrations', '*{.ts,.js}')],
    synchronize: false,
    logging: false,
  });

  await dataSource.initialize();

  try {
    const pending: { timestamp: number; name: string }[] = [];
    for (const migration of dataSource.migrations) {
      // `dataSource.migrations` está tipado como `MigrationInterface[]` y no expone el timestamp;
      // TypeORM lo deriva de los dígitos finales del nombre de la clase, mismo criterio que acá.
      const name = migration.constructor.name;
      const timestamp = Number(/(\d+)$/.exec(name)?.[1]);
      if (!timestamp) {
        throw new Error(
          `La migración ${name} no termina en un timestamp; no se puede registrar.`,
        );
      }

      const already = await dataSource.query(
        'SELECT 1 FROM migrations WHERE name = $1',
        [name],
      );
      if (already.length === 0) {
        pending.push({ timestamp, name });
      }
    }

    if (pending.length === 0) {
      console.log('No hay migraciones pendientes: la base ya está al día.');
      return;
    }

    pending.sort((a, b) => a.timestamp - b.timestamp);

    console.log(
      `Se marcarán como aplicadas ${pending.length} migraciones, SIN ejecutarlas:`,
    );
    for (const m of pending) {
      console.log(`  - ${m.name}`);
    }

    if (!confirmed) {
      console.log(
        '\nNo se escribió nada. Esto sólo es correcto si el esquema de esta base ya está al día\n' +
          'con las entidades (lo estará si venía corriendo con synchronize: true). Para aplicarlo:\n' +
          '  npm run migration:baseline -- --confirm',
      );
      return;
    }

    await dataSource.transaction(async (manager) => {
      for (const m of pending) {
        await manager.query(
          'INSERT INTO migrations("timestamp", "name") VALUES ($1, $2)',
          [m.timestamp, m.name],
        );
      }
    });

    console.log(
      `\nListo: ${pending.length} migraciones registradas. A partir de ahora sólo se aplicarán las nuevas.`,
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error('Error al alinear el historial de migraciones:', error);
  process.exit(1);
});

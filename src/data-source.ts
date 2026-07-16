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
});

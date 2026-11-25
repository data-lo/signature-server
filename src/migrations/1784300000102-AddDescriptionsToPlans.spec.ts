import type { QueryRunner } from 'typeorm';

import { AddDescriptionsToPlans1784300000102 } from './1784300000102-AddDescriptionsToPlans';

/**
 * La migración se aplica de verdad sobre `signature_db` al arrancar el servidor; aquí se fija el
 * contrato del SQL: columna no nula con `[]` por defecto (los planes existentes siguen siendo
 * válidos sin backfill), restricción de arreglo, y un `down` que deshace exactamente eso.
 */
describe('AddDescriptionsToPlans1784300000102', () => {
  let queryRunner: { query: jest.Mock };
  let migration: AddDescriptionsToPlans1784300000102;

  beforeEach(() => {
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
    migration = new AddDescriptionsToPlans1784300000102();
  });

  it('agrega descriptions como jsonb no nulo con [] por defecto', async () => {
    await migration.up(queryRunner as unknown as QueryRunner);

    expect(queryRunner.query).toHaveBeenNthCalledWith(
      1,
      `ALTER TABLE "plans" ADD COLUMN "descriptions" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
  });

  it('restringe la columna a arreglos JSON', async () => {
    await migration.up(queryRunner as unknown as QueryRunner);

    expect(queryRunner.query).toHaveBeenNthCalledWith(
      2,
      `ALTER TABLE "plans" ADD CONSTRAINT "CHK_plans_descriptions_array" CHECK (jsonb_typeof("descriptions") = 'array')`,
    );
  });

  it('el down quita la restricción antes que la columna', async () => {
    await migration.down(queryRunner as unknown as QueryRunner);

    expect(queryRunner.query.mock.calls).toEqual([
      ['ALTER TABLE "plans" DROP CONSTRAINT "CHK_plans_descriptions_array"'],
      ['ALTER TABLE "plans" DROP COLUMN "descriptions"'],
    ]);
  });

  it('conserva el nombre con el que TypeORM la registra', () => {
    expect(migration.name).toBe('AddDescriptionsToPlans1784300000102');
  });
});

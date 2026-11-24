import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega `descriptions` a `plans`: la lista ordenada de beneficios que el frontend pinta en la
 * tarjeta de cada plan.
 *
 * `jsonb NOT NULL DEFAULT '[]'`: los planes existentes quedan con una lista vacía y siguen
 * funcionando sin tocar nada más. El `CHECK` asegura que lo guardado sea un arreglo (el contenido
 * de cada elemento lo valida el endpoint que lo escribe); un objeto o un escalar romperían a
 * cualquier lector que espere poder iterarlo.
 *
 * @example
 * ```sql
 * SELECT plan_type, descriptions FROM plans;
 * -- premium | ["Hasta 100 documentos", "Firma biométrica"]
 * ```
 */
export class AddDescriptionsToPlans1784300000102 implements MigrationInterface {
  name = 'AddDescriptionsToPlans1784300000102';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "plans" ADD COLUMN "descriptions" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "plans" ADD CONSTRAINT "CHK_plans_descriptions_array" CHECK (jsonb_typeof("descriptions") = 'array')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "plans" DROP CONSTRAINT "CHK_plans_descriptions_array"',
    );
    await queryRunner.query('ALTER TABLE "plans" DROP COLUMN "descriptions"');
  }
}

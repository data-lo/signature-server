import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ER-V2 (diagrama más reciente): `collaborators.user_id` -> `collaborators.account_id`,
 * apuntando a la cuenta PERSONAL del colaborador en vez de directo a `users` — consistente con
 * el resto del modelo multi-tenant (`documents.account_id`, ver `AddAccountIdToDocuments`), y
 * evita la ambigüedad de "cuál membresía" para una persona con varias organizaciones.
 *
 * Backfill: cada fila con user_id no nulo se resuelve a la cuenta PERSONAL de ese usuario. Si
 * algún colaborador no encuentra una (no debería pasar — todo usuario registrado tiene una
 * cuenta personal desde `createDefaultPersonalAccount`), el `UPDATE`/verificación de abajo lo
 * detecta y la migración falla a propósito, mismo criterio que `AddAccountIdToDocuments`: mejor
 * detener la migración que dejar una fila sin ancla de identidad en un modelo que la necesita.
 * Las filas con user_id NULL (invitación solo por email) se quedan con account_id NULL — mismo
 * significado que antes.
 */
export class RenameCollaboratorUserIdToAccountId1784300000011 implements MigrationInterface {
  name = 'RenameCollaboratorUserIdToAccountId1784300000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "collaborators" DROP CONSTRAINT "FK_collaborators_user_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "collaborators" ADD "account_id" uuid`,
    );

    await queryRunner.query(`
      UPDATE "collaborators" c
      SET "account_id" = (
        SELECT a."id"
        FROM "accounts" a
        WHERE a."user_id" = c."user_id" AND a."account_type" = 'PERSONAL'
        LIMIT 1
      )
      WHERE c."user_id" IS NOT NULL
    `);

    const orphaned = await queryRunner.query(`
      SELECT COUNT(*)::int AS count FROM "collaborators"
      WHERE "user_id" IS NOT NULL AND "account_id" IS NULL
    `);
    if (orphaned[0]?.count > 0) {
      throw new Error(
        `${orphaned[0].count} fila(s) de collaborators tienen user_id pero no se les encontró una cuenta PERSONAL — revisar antes de continuar.`,
      );
    }

    await queryRunner.query(
      `ALTER TABLE "collaborators" DROP COLUMN "user_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "collaborators" ADD CONSTRAINT "FK_collaborators_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "collaborators" DROP CONSTRAINT "FK_collaborators_account_id"`,
    );

    await queryRunner.query(`ALTER TABLE "collaborators" ADD "user_id" uuid`);

    await queryRunner.query(`
      UPDATE "collaborators" c
      SET "user_id" = (
        SELECT a."user_id" FROM "accounts" a WHERE a."id" = c."account_id"
      )
      WHERE c."account_id" IS NOT NULL
    `);

    await queryRunner.query(
      `ALTER TABLE "collaborators" DROP COLUMN "account_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "collaborators" ADD CONSTRAINT "FK_collaborators_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }
}

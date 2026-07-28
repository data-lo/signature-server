import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega documents.account_id para que los documentos queden scopeados por
 * cuenta activa (multi-tenant). Los documentos existentes se backfillean con
 * la cuenta PERSONAL de su creador (documents.created_by) — decisión de
 * producto: ningún documento queda huérfano y nada cambia visiblemente para
 * el usuario que ya los tenía. Si algún documento no encuentra una cuenta
 * PERSONAL para su creador, el ALTER COLUMN SET NOT NULL de abajo falla
 * (a propósito: mejor detener la migración que dejar una fila con
 * account_id = NULL en un modelo que ya no lo permite).
 */
export class AddAccountIdToDocuments1784080000000 implements MigrationInterface {
  name = 'AddAccountIdToDocuments1784080000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "documents" ADD "account_id" uuid`);

    await queryRunner.query(`
      UPDATE "documents" d
      SET "account_id" = (
        SELECT a."id"
        FROM "accounts" a
        INNER JOIN "account_members" am ON am."account_id" = a."id"
        WHERE am."user_id" = d."created_by" AND a."type" = 'PERSONAL'
        LIMIT 1
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "documents" ALTER COLUMN "account_id" SET NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "documents" ADD CONSTRAINT "FK_documents_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts"("id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT "FK_documents_account_id"`,
    );
    await queryRunner.query(`ALTER TABLE "documents" DROP COLUMN "account_id"`);
  }
}

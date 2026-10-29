import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega `sealed_at` a `document_seals`: el momento en que el PSC emitió la constancia, que la
 * respuesta de Seal Service ya traía y se estaba descartando al mapear. Es lo que la hoja de
 * evidencia imprime como "EMITIDO" en la tabla de la Constancia de Conservación (NOM-151).
 *
 * Nullable a propósito: los sellos emitidos antes de esta columna no tienen cómo recuperarla —
 * el dato solo venía en aquella respuesta.
 */
export class AddSealedAtToDocumentSeals1784300000026 implements MigrationInterface {
  name = 'AddSealedAtToDocumentSeals1784300000026';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "document_seals" ADD COLUMN "sealed_at" TIMESTAMP WITH TIME ZONE',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "document_seals" DROP COLUMN "sealed_at"',
    );
  }
}

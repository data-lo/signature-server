import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enciende Búsqueda Inteligente en todas las organizaciones y deja `true` como valor por omisión
 * de `organizations.index_documents`.
 *
 * Hasta ahora la columna no la leía ni la escribía nadie: ningún cliente mandaba `indexDocuments`
 * al crear una organización, así que todas quedaron en el `false` del default. Desde esta versión
 * el interruptor se ve y se edita en "Información de la organización", y además manda sobre la
 * casilla `isIndexable` de cada documento. Dejar esos `false` convertiría un default que nadie
 * eligió en "no indexar nada", y cambiaría en silencio lo que ya pasaba con sus documentos, que
 * nacían indexables por la regla "quien no opina, indexa".
 *
 * **Por eso se encienden también las existentes**, no sólo las nuevas: es el valor que refleja lo
 * que venía ocurriendo. Quien no quiera la búsqueda la apaga desde su perfil.
 */
export class IndexDocumentsByDefault1784300000068 implements MigrationInterface {
  name = 'IndexDocumentsByDefault1784300000068';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ALTER COLUMN "index_documents" SET DEFAULT true`,
    );

    await queryRunner.query(
      `UPDATE "organizations" SET "index_documents" = true WHERE "index_documents" = false`,
    );
  }

  /**
   * Devuelve el default anterior. Es una reversión CON PÉRDIDA: no hay forma de distinguir las
   * organizaciones que esta migración encendió de las que alguien encendió después, así que los
   * valores se quedan como están y sólo cambia el default de las filas nuevas.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ALTER COLUMN "index_documents" SET DEFAULT false`,
    );
  }
}

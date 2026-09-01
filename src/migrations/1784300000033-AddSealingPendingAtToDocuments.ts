import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega `sealing_pending_at` a `documents`: desde cuándo un documento firmado espera su
 * constancia de conservación NOM-151.
 *
 * Existe porque la firma avanzada y el sellado pueden separarse en el tiempo. Obtener la
 * evidencia OCSP exige consultar al respondedor del SAT, que se cae con frecuencia; cuando eso
 * pasa el documento se firma igual —bloquear la firma por una caída ajena sería peor— pero queda
 * sin evidencia de revocación y, con ella, sin poder sellarse. La marca deja constancia de ese
 * estado para poder retomarlo y para poder decírselo al usuario.
 *
 * **Es una columna aparte y no un `status` nuevo**: el documento SÍ está firmado, y moverlo fuera
 * de SIGNED rompería los filtros, los permisos y la vista pública, que exige ese estado para
 * publicar la evidencia. Lo que está pendiente es el sellado, no la firma.
 *
 * Nullable: `NULL` significa que no hay nada pendiente, que es el caso de todos los documentos
 * existentes y de los que se sellan con normalidad.
 */
export class AddSealingPendingAtToDocuments1784300000033 implements MigrationInterface {
  name = 'AddSealingPendingAtToDocuments1784300000033';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "documents" ADD COLUMN "sealing_pending_at" TIMESTAMP WITH TIME ZONE',
    );

    /**
     * Índice parcial: las consultas que importan buscan SÓLO los pendientes, que son una minoría
     * frente a la tabla entera. Indexar nada más las filas con valor mantiene el índice pequeño y
     * evita cargar con las millones de filas en NULL.
     */
    await queryRunner.query(
      'CREATE INDEX "IDX_documents_sealing_pending" ON "documents" ("sealing_pending_at") WHERE "sealing_pending_at" IS NOT NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_documents_sealing_pending"');
    await queryRunner.query(
      'ALTER TABLE "documents" DROP COLUMN "sealing_pending_at"',
    );
  }
}

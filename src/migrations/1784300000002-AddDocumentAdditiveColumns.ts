import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migración ER-V2, Fase 1 (ver plan de migración): agrega a documents las columnas
 * aditivas que pide el diagrama objetivo y que hoy no existen. Todas son nullable o
 * tienen un default seguro — ningún caller existente se ve afectado:
 *
 * - is_sequential: default true, porque ya es el comportamiento implícito hoy (el
 *   sistema siempre exige firma secuencial por sign_order, nunca en paralelo).
 * - expiration_date, visibility_level, requires_verification, index_document: no-op
 *   hasta que se conecten flujos futuros (verificación en Fase 7, indexado, etc.).
 * - organization_id: se deja SIN foreign key todavía a propósito. Hoy "accounts" es el
 *   contenedor de tenant (incluye organizaciones); en la Fase 5 del plan, Organization
 *   pasa a ser una entidad propia y este campo se re-apunta ahí con su FK real. Ponerle
 *   una FK ahora apuntaría a la tabla equivocada y habría que migrarla de nuevo.
 * - seal_key: se autogenera para las filas existentes (uuid_generate_v4(), misma
 *   extensión que ya usa el resto del schema — ver InitialSchema).
 * - total_signers / completed_signers_count: se backfillean contando los participantes
 *   reales de cada documento (rol signer / status signed) para que los documentos ya
 *   existentes no queden en 0 de forma incorrecta.
 * - reviewed_by: no-op hasta el flujo de revisión (Fase 6, rol REVIEWER).
 */
export class AddDocumentAdditiveColumns1784300000002
  implements MigrationInterface
{
  name = 'AddDocumentAdditiveColumns1784300000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
        ADD "is_sequential" boolean NOT NULL DEFAULT true,
        ADD "expiration_date" TIMESTAMP,
        ADD "organization_id" uuid,
        ADD "visibility_level" integer NOT NULL DEFAULT 0,
        ADD "seal_key" uuid NOT NULL DEFAULT uuid_generate_v4(),
        ADD "total_signers" integer,
        ADD "completed_signers_count" integer NOT NULL DEFAULT 0,
        ADD "reviewed_by" uuid,
        ADD "requires_verification" boolean NOT NULL DEFAULT false,
        ADD "index_document" boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      UPDATE "documents" d
      SET "total_signers" = COALESCE((
        SELECT COUNT(*) FROM "document_participants" dp
        WHERE dp."document_id" = d."id" AND dp."role" = 'signer'
      ), 0)
    `);

    await queryRunner.query(`
      UPDATE "documents" d
      SET "completed_signers_count" = COALESCE((
        SELECT COUNT(*) FROM "document_participants" dp
        WHERE dp."document_id" = d."id" AND dp."role" = 'signer' AND dp."status" = 'signed'
      ), 0)
    `);

    await queryRunner.query(
      `ALTER TABLE "documents" ALTER COLUMN "total_signers" SET NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
        DROP COLUMN "is_sequential",
        DROP COLUMN "expiration_date",
        DROP COLUMN "organization_id",
        DROP COLUMN "visibility_level",
        DROP COLUMN "seal_key",
        DROP COLUMN "total_signers",
        DROP COLUMN "completed_signers_count",
        DROP COLUMN "reviewed_by",
        DROP COLUMN "requires_verification",
        DROP COLUMN "index_document"
    `);
  }
}

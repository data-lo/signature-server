import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega `signature_type` a `documents`: con qué tipo de firma se creó el documento.
 *
 * El dato ya era una decisión de documento —llega en `documentData.signatureType` y vale para
 * todos sus firmantes desde la historia "Selección de tipo de firma al crear documentos"— pero
 * sólo se guardaba copiado en `collaborators.signature_type`, una fila por firmante. **El
 * documento no podía responder con qué se firma sin preguntárselo a sus colaboradores**, y quien
 * lo necesitara tenía que confiar en que todos coincidieran. El primero en necesitarlo es el
 * recibo de crédito (`document_credit_consumptions.signature_type`), que se escribía en `null`.
 *
 * **Mismo tipo enumerado que los colaboradores** (`'simple'`, `'fiel'`) y no el vocabulario
 * comercial de facturación (`SIMPLE`/`ADVANCED`): dentro del módulo de documentos el tipo de
 * firma ya se llama así, y que el documento dijera `ADVANCED` mientras sus firmantes dicen
 * `fiel` metería un tercer vocabulario para el mismo dato. La traducción a facturación se hace
 * en el único punto que cruza la frontera (ver `SIGNATURE_TYPE_DOMAIN_TO_BILLING` en
 * `CreateDocumentSignatureFlowUseCase`).
 *
 * **Nullable y sin backfill, a propósito.** No se deduce el tipo de los documentos existentes a
 * partir de sus colaboradores: sería inventar una decisión que nadie tomó a nivel documento, y
 * los documentos del flujo viejo (`CreateDocumentUseCase`, que no pide tipo de firma) tienen
 * colaboradores con `signature_type` en `null` de todas formas. `null` significa "no se decidió",
 * y es distinto de SIMPLE.
 *
 * Los consumos de crédito históricos tampoco se tocan: los que ya están escritos con
 * `signature_type` en `null` se quedan así. Esta migración no reescribe ninguna fila existente.
 *
 * El tipo se crea con la comprobación previa sobre `pg_type` —`CREATE TYPE` no admite
 * `IF NOT EXISTS`— y la columna con `IF NOT EXISTS`. Hoy el esquema lo gobiernan sólo las
 * migraciones (`synchronize: false`, ver `app.module.ts`), pero las bases de los entornos
 * actuales se construyeron cuando TypeORM aún derivaba tablas de las entidades, y varias
 * migraciones de esta serie ya arrastran objetos creados por aquel camino. Escribirla de forma
 * repetible cuesta dos líneas y hace que converja desde cualquiera de los dos puntos de partida
 * en vez de abortar el arranque con "column already exists".
 */
export class AddSignatureTypeToDocuments1784300000049
  implements MigrationInterface
{
  name = 'AddSignatureTypeToDocuments1784300000049';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * El nombre sigue la convención que genera TypeORM (`{tabla}_{columna}_enum`) para que
     * `synchronize` y esta migración describan exactamente el mismo tipo y no se peleen. Es un
     * tipo propio y no el `collaborators_signature_type_enum` que ya existe: TypeORM crea uno por
     * columna, y reutilizar el del colaborador ataría el esquema de `documents` a los cambios de
     * enum de otra tabla.
     */
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'documents_signature_type_enum'
        ) THEN
          CREATE TYPE "public"."documents_signature_type_enum"
            AS ENUM ('simple', 'fiel');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "documents"
      ADD COLUMN IF NOT EXISTS "signature_type"
        "public"."documents_signature_type_enum"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // La columna se va primero: el tipo no se puede borrar mientras alguien lo use.
    await queryRunner.query(`
      ALTER TABLE "documents" DROP COLUMN IF EXISTS "signature_type"
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "public"."documents_signature_type_enum"
    `);
  }
}

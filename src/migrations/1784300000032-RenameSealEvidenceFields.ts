import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `nom151_evidence` sonaba a "el estándar mexicano", cuando lo que guarda es la constancia de
 * integridad del documento — no todo el sellado es NOM-151. Se renombra a `integrity_evidence`
 * para que la columna diga lo que contiene, en paralelo con `timestamp_evidence` (que conserva su
 * nombre: solo cambia su estructura JSON).
 *
 * Dentro de ambos JSONB, `tokenBase64` era ambiguo (no es un token de autenticación, es el archivo
 * de la constancia) y se renombra a `fileBase64`. Se agrega `issuedAt` — el momento de emisión que
 * ya vive en `sealed_at` para toda la fila, pero que ahora también viaja dentro de cada evidencia
 * para que cada una sea autocontenida. Para las filas selladas antes de que existiera `sealed_at`,
 * `issuedAt` queda en `null`: ese dato no se puede recuperar retroactivamente.
 */
export class RenameSealEvidenceFields1784300000032 implements MigrationInterface {
  name = 'RenameSealEvidenceFields1784300000032';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "document_seals" RENAME COLUMN "nom151_evidence" TO "integrity_evidence"',
    );

    await queryRunner.query(`
      UPDATE "document_seals"
      SET
        "timestamp_evidence" = ("timestamp_evidence" - 'tokenBase64') || jsonb_build_object(
          'fileBase64', "timestamp_evidence" -> 'tokenBase64',
          'issuedAt', CASE
            WHEN "sealed_at" IS NULL THEN 'null'::jsonb
            ELSE to_jsonb(to_char("sealed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
          END
        ),
        "integrity_evidence" = ("integrity_evidence" - 'tokenBase64') || jsonb_build_object(
          'fileBase64', "integrity_evidence" -> 'tokenBase64',
          'issuedAt', CASE
            WHEN "sealed_at" IS NULL THEN 'null'::jsonb
            ELSE to_jsonb(to_char("sealed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
          END
        )
      WHERE "timestamp_evidence" IS NOT NULL OR "integrity_evidence" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "document_seals"
      SET
        "timestamp_evidence" = ("timestamp_evidence" - 'fileBase64' - 'issuedAt')
          || jsonb_build_object('tokenBase64', "timestamp_evidence" -> 'fileBase64'),
        "integrity_evidence" = ("integrity_evidence" - 'fileBase64' - 'issuedAt')
          || jsonb_build_object('tokenBase64', "integrity_evidence" -> 'fileBase64')
      WHERE "timestamp_evidence" IS NOT NULL OR "integrity_evidence" IS NOT NULL
    `);

    await queryRunner.query(
      'ALTER TABLE "document_seals" RENAME COLUMN "integrity_evidence" TO "nom151_evidence"',
    );
  }
}

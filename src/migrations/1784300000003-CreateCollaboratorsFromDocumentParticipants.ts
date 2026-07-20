import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migración ER-V2, Fase 3 (ver plan de migración): reemplaza document_participants por
 * collaborators — generaliza "participante" a "colaborador": agrega el rol REVIEWER,
 * permite invitar solo por email (user_id nullable), y suma comments/geo_loc/
 * cancellation_reason/reminder_periodicity/signature_type que no existían antes.
 *
 * Decisiones de nomenclatura (confirmadas con el equipo, ver Fase 2 del plan):
 * - role SPECTATOR -> colaborator_type WATCHER (mismo concepto, nombre del diagrama).
 * - status: mismos 3 valores que hoy (pending/signed/rejected), solo renombrado a SIGNEE_STATUS.
 *
 * Se copian las filas existentes preservando su "id" (sin remapeo de FK en otras tablas).
 * ip_address se backfillea desde el documento padre — document_participants nunca tuvo su
 * propia IP; es una aproximación documentada, no un dato histórico real por colaborador.
 * rejection_reason se mapea a cancellation_reason (aproximación: "rechazo" y "cancelación"
 * no son lo mismo conceptualmente, pero es el campo más cercano). rejected_at NO se migra:
 * no tiene equivalente en el diagrama: se documenta como pérdida intencional en down().
 *
 * document_participants NO se borra — se renombra a document_participants_deprecated y
 * queda de solo lectura un ciclo como referencia de rollback de emergencia; el DROP real
 * queda para una migración de limpieza posterior.
 */
export class CreateCollaboratorsFromDocumentParticipants1784300000003 implements MigrationInterface {
  name = 'CreateCollaboratorsFromDocumentParticipants1784300000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."collaborators_status_enum" AS ENUM('pending', 'signed', 'rejected')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."collaborators_colaborator_type_enum" AS ENUM('signer', 'reviewer', 'watcher')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."collaborators_reminder_periodicity_enum" AS ENUM('none', 'daily', 'weekly')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."collaborators_signature_type_enum" AS ENUM('simple', 'fiel')`,
    );

    await queryRunner.query(`
      CREATE TABLE "collaborators" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL,
        "user_id" uuid,
        "email" character varying,
        "signing_order" integer,
        "signed_at" TIMESTAMP,
        "status" "public"."collaborators_status_enum" NOT NULL DEFAULT 'pending',
        "comments" text,
        "ip_address" character varying NOT NULL,
        "geo_loc" jsonb,
        "visibility_level" integer,
        "cancellation_reason" text,
        "reminder_periodicity" "public"."collaborators_reminder_periodicity_enum",
        "signature_type_id" uuid,
        "signature_type" "public"."collaborators_signature_type_enum",
        "colaborator_type" "public"."collaborators_colaborator_type_enum" NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_collaborators" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "collaborators" ADD CONSTRAINT "FK_collaborators_document_id" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "collaborators" ADD CONSTRAINT "FK_collaborators_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    await queryRunner.query(`
      INSERT INTO "collaborators" (
        "id", "document_id", "user_id", "signing_order", "signed_at", "status",
        "cancellation_reason", "colaborator_type", "ip_address", "created_at", "updated_at"
      )
      SELECT
        dp."id", dp."document_id", dp."user_id", dp."sign_order", dp."signed_at",
        dp."status"::text::"public"."collaborators_status_enum",
        dp."rejection_reason",
        (CASE WHEN dp."role" = 'signer' THEN 'signer' ELSE 'watcher' END)::"public"."collaborators_colaborator_type_enum",
        d."ip_address",
        dp."created_at", dp."updated_at"
      FROM "document_participants" dp
      INNER JOIN "documents" d ON d."id" = dp."document_id"
    `);

    await queryRunner.query(
      `ALTER TABLE "document_participants" RENAME TO "document_participants_deprecated"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const deprecatedExists = await queryRunner.query(`
      SELECT 1 FROM "information_schema"."tables"
      WHERE "table_schema" = 'public' AND "table_name" = 'document_participants_deprecated'
    `);
    if (deprecatedExists.length > 0) {
      await queryRunner.query(
        `ALTER TABLE "document_participants_deprecated" RENAME TO "document_participants"`,
      );
    }

    // Reversión con pérdida: cualquier fila creada en "collaborators" después de la
    // migración up() (incluyendo comments, geo_loc, colaboradores solo-por-email, tipo
    // REVIEWER, reminder_periodicity, signature_type) no existe en
    // document_participants_deprecated y se pierde al revertir — solo las filas copiadas
    // originalmente en up() siguen intactas en la tabla restaurada.
    await queryRunner.query(`DROP TABLE "collaborators"`);

    await queryRunner.query(
      `DROP TYPE "public"."collaborators_colaborator_type_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."collaborators_status_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."collaborators_reminder_periodicity_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."collaborators_signature_type_enum"`,
    );
  }
}

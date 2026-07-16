import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reemplaza AccountMemberEntity.role (enum-array OWNER/ADMIN/SIGNEE) por una
 * FK real (role_id) al catálogo RBAC (roles/permissions/role_permissions —
 * ver migración CreateRolesModule). Decisión de producto (confirmada con el
 * equipo): dado que hoy ADMIN y SIGNEE son funcionalmente idénticos en el
 * código (ningún check los distingue, ambos fallan el gate de OWNER), el
 * backfill mapea OWNER->rol de sistema ADMIN y {ADMIN,SIGNEE}->rol de
 * sistema MEMBER (cuyos permisos seed — READ+CREATE sobre DOCUMENT — calzan
 * con alguien cuyo rol es firmar/ver documentos, no administrar la cuenta).
 *
 * Los roles ADMIN/MEMBER se insertan aquí mismo (idempotente, WHERE NOT
 * EXISTS) en vez de depender de que "npm run seed:roles" ya se haya corrido:
 * `migrationsRun: true` aplica esta migración automáticamente al arrancar,
 * pero el seed es un script manual aparte — sin este insert, el backfill de
 * abajo podría no encontrar ningún rol al que apuntar. El resto del seed
 * (resources/actions/permissions/role_permissions) sigue siendo responsabilidad
 * exclusiva de "npm run seed:roles", no de esta migración.
 */
export class ReplaceAccountMemberRoleWithRoleId1784233400000 implements MigrationInterface {
  name = 'ReplaceAccountMemberRoleWithRoleId1784233400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "roles" ("name", "is_system_role", "organization_id")
      SELECT 'ADMIN', true, NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM "roles" WHERE "name" = 'ADMIN' AND "is_system_role" = true
      )
    `);
    await queryRunner.query(`
      INSERT INTO "roles" ("name", "is_system_role", "organization_id")
      SELECT 'MEMBER', true, NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM "roles" WHERE "name" = 'MEMBER' AND "is_system_role" = true
      )
    `);

    await queryRunner.query(`ALTER TABLE "account_members" ADD "role_id" uuid`);

    await queryRunner.query(`
      UPDATE "account_members" am
      SET "role_id" = (
        SELECT r."id" FROM "roles" r
        WHERE r."is_system_role" = true
          AND r."name" = CASE WHEN 'OWNER' = ANY(am."role") THEN 'ADMIN' ELSE 'MEMBER' END
        LIMIT 1
      )
      WHERE am."role" IS NOT NULL
    `);

    await queryRunner.query(
      `ALTER TABLE "account_members" ADD CONSTRAINT "FK_account_members_role_id" FOREIGN KEY ("role_id") REFERENCES "roles"("id")`,
    );

    await queryRunner.query(`ALTER TABLE "account_members" DROP COLUMN "role"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."account_members_role_enum"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."account_members_role_enum" AS ENUM('OWNER', 'ADMIN', 'SIGNEE')`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_members" ADD "role" "public"."account_members_role_enum" array`,
    );

    // Reversión con pérdida: el enum original de 3 valores no puede
    // reconstruirse exactamente a partir de los 2 roles de sistema (ver
    // docblock arriba) — ADMIN->[OWNER], MEMBER->[SIGNEE] (el más
    // restrictivo de los dos que colapsaron en MEMBER).
    await queryRunner.query(`
      UPDATE "account_members" am
      SET "role" = CASE
        WHEN r."name" = 'ADMIN' THEN ARRAY['OWNER']::"public"."account_members_role_enum"[]
        WHEN r."name" = 'MEMBER' THEN ARRAY['SIGNEE']::"public"."account_members_role_enum"[]
        ELSE NULL
      END
      FROM "roles" r
      WHERE r."id" = am."role_id"
    `);

    await queryRunner.query(
      `ALTER TABLE "account_members" DROP CONSTRAINT "FK_account_members_role_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_members" DROP COLUMN "role_id"`,
    );
  }
}

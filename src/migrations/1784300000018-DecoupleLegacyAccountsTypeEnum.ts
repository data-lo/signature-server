import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bug corregido: "accounts_type_enum" estaba compartido entre la tabla "accounts" (viva, la que
 * mapea AccountEntity) y "accounts_legacy_tenant" (congelada desde MergeAccountAndOrganization,
 * conservada solo para rollback/histórico — ver esa migración, que la creó con un simple
 * `ALTER TABLE "accounts" RENAME TO "accounts_legacy_tenant"`, heredando el mismo tipo enum sin
 * darse cuenta de que quedaba compartido con la tabla nueva).
 *
 * Cuando `synchronize: true` (ver app.module.ts) necesita reconstruir ese tipo enum —
 * renombrarlo a "_old", crear el nuevo, migrar la columna de "accounts", y por último
 * `DROP TYPE accounts_type_enum_old` — Postgres se niega a soltar el tipo viejo porque
 * "accounts_legacy_tenant.type" todavía lo referencia. Eso tumbaba el arranque del backend en
 * cada intento con "cannot drop type accounts_type_enum_old because other objects depend on it"
 * (confirmado con `pg_depend` antes de escribir esta migración: es el ÚNICO tipo enum compartido
 * entre dos tablas en toda la base de datos — ninguna otra tabla legacy/deprecated tiene este
 * mismo problema).
 *
 * Se le da a "accounts_legacy_tenant.type" su propio tipo enum, idéntico en valores pero
 * desacoplado — no se toca ningún dato ni se altera "accounts_legacy_tenant" de ninguna otra
 * forma; sigue sirviendo exactamente el mismo propósito de rollback/histórico que tenía.
 */
export class DecoupleLegacyAccountsTypeEnum1784300000018 implements MigrationInterface {
  name = 'DecoupleLegacyAccountsTypeEnum1784300000018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."accounts_legacy_tenant_type_enum" AS ENUM('PERSONAL', 'ORGANIZATION')`,
    );
    await queryRunner.query(`
      ALTER TABLE "accounts_legacy_tenant"
      ALTER COLUMN "type" TYPE "public"."accounts_legacy_tenant_type_enum"
      USING "type"::text::"public"."accounts_legacy_tenant_type_enum"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "accounts_legacy_tenant"
      ALTER COLUMN "type" TYPE "public"."accounts_type_enum"
      USING "type"::text::"public"."accounts_type_enum"
    `);
    await queryRunner.query(
      `DROP TYPE "public"."accounts_legacy_tenant_type_enum"`,
    );
  }
}

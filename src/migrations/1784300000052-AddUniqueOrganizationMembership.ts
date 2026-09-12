import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Restituye la unicidad de la membresía: un usuario no puede tener dos filas en la misma
 * organización.
 *
 * La garantía existía como `UQ_64ad7a24bdd270694561759c6b7 UNIQUE ("account_id", "user_id")` en la
 * vieja tabla `account_members`, y **se perdió al fusionarla dentro de `accounts`**
 * (`1784300000005-MergeAccountAndOrganization`): la tabla resultante se creó sólo con su clave
 * primaria. Desde entonces lo único que impide la fila repetida son lecturas previas en la capa de
 * aplicación —`findExistingMembership` al dar de alta, la comprobación de `finalizeAcceptance` al
 * aceptar una invitación—, y un leer-luego-escribir no sobrevive a dos peticiones simultáneas:
 * ambas leen "no existe" y ambas insertan.
 *
 * Duplicar la membresía duplica también la asignación del rol, que es lo que de verdad duele:
 * `assertHasOrganizationPermission` resuelve el rol del llamador con un `findOne`, así que con dos
 * filas del mismo usuario decide con la que Postgres devuelva primero. Un miembro degradado a
 * MEMBER que conserve una fila vieja con ADMIN seguiría administrando la organización.
 *
 * **Índice parcial, no restricción UNIQUE**, porque `organization_id` es NULL en las cuentas
 * personales: en Postgres los NULL no chocan entre sí, así que una restricción a secas también
 * funcionaría, pero el índice parcial dice explícitamente que la regla es sólo para membresías de
 * organización y no indexa filas que nunca va a comparar.
 *
 * **Incluye las membresías dadas de baja a propósito.** Revocar el acceso deja la fila con
 * `is_active = false` en vez de borrarla (`RevokeAccountAccessUseCase`), y readmitir a alguien
 * reactiva esa fila: es justo lo que `findExistingMembership` busca al mirar sin filtrar por
 * `is_active`. Un índice que sólo cubriera las activas dejaría volver a insertar encima de la baja
 * y partiría en dos el historial de esa persona en la organización.
 *
 * Si la base ya trae duplicados, la creación del índice falla y la migración se detiene con el
 * detalle de los pares afectados. Es deliberado: elegir por el usuario qué fila conservar
 * significaría decidir con qué rol se queda esa persona, y eso no lo puede resolver una migración.
 */
export class AddUniqueOrganizationMembership1784300000052 implements MigrationInterface {
  name = 'AddUniqueOrganizationMembership1784300000052';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * El diagnóstico va antes del CREATE INDEX porque el error nativo de Postgres ("could not
     * create unique index ... Key (user_id, organization_id)=(...) is duplicated") nombra un solo
     * par y no dice cuántas filas hay detrás ni con qué rol. Quien tenga que limpiarlo necesita
     * la lista entera.
     */
    const duplicates: {
      user_id: string;
      organization_id: string;
      total: string;
    }[] = await queryRunner.query(`
        SELECT "user_id", "organization_id", COUNT(*) AS "total"
        FROM "accounts"
        WHERE "organization_id" IS NOT NULL
        GROUP BY "user_id", "organization_id"
        HAVING COUNT(*) > 1
      `);

    if (duplicates.length > 0) {
      const detail = duplicates
        .map(
          (row) =>
            `usuario ${row.user_id} en organización ${row.organization_id} (${row.total} filas)`,
        )
        .join('; ');

      throw new Error(
        `No se puede crear el índice único de membresías: ya hay membresías duplicadas. ` +
          `Consolídalas a mano —conservando la fila con el rol vigente— y vuelve a correr la ` +
          `migración. Duplicados: ${detail}`,
      );
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_accounts_user_id_organization_id"
      ON "accounts" ("user_id", "organization_id")
      WHERE "organization_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_accounts_user_id_organization_id"
    `);
  }
}

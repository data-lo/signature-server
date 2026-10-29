import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Las API keys de integración pueden ser emitidas por el servicio interno de la plataforma, sin
 * inventar una membresía de ese servicio dentro de cada organización cliente. Las llaves previas
 * conservan su autor; una llave de plataforma usa `created_by_account_id = NULL`.
 */
export class AllowPlatformIssuedApiKeys1784300000086
  implements MigrationInterface
{
  name = 'AllowPlatformIssuedApiKeys1784300000086';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "api_keys" ALTER COLUMN "created_by_account_id" DROP NOT NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revertir sólo es seguro si no se emitió ninguna llave de plataforma desde esta migración.
    const [{ count }] = await queryRunner.query(
      'SELECT COUNT(*)::int AS "count" FROM "api_keys" WHERE "created_by_account_id" IS NULL',
    );
    if (count > 0) {
      throw new Error(
        'No se puede revertir AllowPlatformIssuedApiKeys: existen API keys emitidas por la plataforma.',
      );
    }
    await queryRunner.query(
      'ALTER TABLE "api_keys" ALTER COLUMN "created_by_account_id" SET NOT NULL',
    );
  }
}

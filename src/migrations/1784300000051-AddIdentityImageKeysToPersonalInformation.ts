import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega a `personal_information` las llaves internas de las imágenes frontal y trasera de la INE
 * que verificó Didit: `front_image_key` y `back_image_key`.
 *
 * **Sólo llaves de objeto de MinIO** (bucket privado `identity-documents`), nunca la URL del
 * proveedor —temporal y externa— ni la imagen en Base64: la base no guarda el documento, sólo dónde
 * lo guardamos nosotros.
 *
 * **Nullable y sin backfill.** La información personal que ya existe no tiene imágenes almacenadas
 * —la descarga desde Didit empieza con esta historia—, y una verificación incompleta tampoco las
 * tiene. `null` significa "todavía no hay INE verificada guardada", y así lo trata el envío a Seal.
 *
 * Repetible con `IF NOT EXISTS`/`IF EXISTS`, como el resto de la serie, para converger desde una base
 * levantada por `synchronize`.
 */
export class AddIdentityImageKeysToPersonalInformation1784300000051 implements MigrationInterface {
  name = 'AddIdentityImageKeysToPersonalInformation1784300000051';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "personal_information"
      ADD COLUMN IF NOT EXISTS "front_image_key" character varying
    `);
    await queryRunner.query(`
      ALTER TABLE "personal_information"
      ADD COLUMN IF NOT EXISTS "back_image_key" character varying
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "personal_information" DROP COLUMN IF EXISTS "back_image_key"
    `);
    await queryRunner.query(`
      ALTER TABLE "personal_information" DROP COLUMN IF EXISTS "front_image_key"
    `);
  }
}

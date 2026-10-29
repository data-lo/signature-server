import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Resultado no sensible de la validación de e.firma (ver `EfirmaService.firmar` / historia
 * "Integrar carga y validación de e.firma en el flujo de firma avanzada"): hash del documento,
 * firma en base64, algoritmo, fecha y datos públicos del certificado (RFC, nombre, número de
 * certificado, PEM). Nunca contiene la llave privada ni la contraseña. `jsonb` nullable, mismo
 * patrón que `geo_loc` en `AddSignatureSnapshotToCollaborators`.
 */
export class AddAdvancedSignatureToCollaborators1784300000024 implements MigrationInterface {
  name = 'AddAdvancedSignatureToCollaborators1784300000024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "collaborators" ADD "advanced_signature" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "collaborators" DROP COLUMN "advanced_signature"`,
    );
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Corrige un bug real: `finalizeSignedDocument` volvía a leer la imagen de firma EN VIVO de
 * cada colaborador al momento de estampar el PDF final (cuando firma el último firmante), no
 * una copia tomada en el momento en que cada quien realmente firmó. Si un firmante desactivaba
 * su firma (`PATCH /signature/:id/deactivate`, que sobrescribe el mismo object key de MinIO
 * con un PNG en blanco) después de firmar pero antes de que el último firmante terminara, el
 * PDF legal final quedaba estampado con una firma en blanco — sin ningún error ni aviso.
 *
 * `signature_snapshot_object_key`: al firmar, se copia la imagen de firma activa del usuario a
 * un object key nuevo e inmutable en MinIO, y se guarda aquí. `finalizeSignedDocument` usa esta
 * copia en vez de volver a resolver `user.signatureId` en vivo. Nullable porque solo los
 * colaboradores que ya firmaron (o firman después de este fix) lo tienen — los que aún no
 * firman no necesitan snapshot todavía.
 */
export class AddSignatureSnapshotToCollaborators1784300000010
  implements MigrationInterface
{
  name = 'AddSignatureSnapshotToCollaborators1784300000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "collaborators" ADD "signature_snapshot_object_key" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "collaborators" DROP COLUMN "signature_snapshot_object_key"`,
    );
  }
}

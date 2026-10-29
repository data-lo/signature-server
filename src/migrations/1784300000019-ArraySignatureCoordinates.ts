import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Historia "Ubicación de firmas por usuario": `simple_signatures.signature_coordinates` pasa de
 * guardar un único objeto de posición (píxeles absolutos) a un arreglo de posiciones (ratios
 * 0-1, una por página/zona donde el firmante colocó su firma) — ver
 * `SimpleSignatureEntity.signatureCoordinates` y `finalizeSignedDocument` en
 * `document.service.ts`, que ya sabe leer tanto el shape nuevo (`SignaturePositionRecord`, con
 * `xRatio`) como el legacy (`LegacySignatureCoordinates`, sin él) dentro de un mismo arreglo.
 *
 * La columna sigue siendo `jsonb` — no hace falta `ALTER TYPE`, solo envolver cada valor
 * existente en un arreglo de un elemento para que el código nuevo (que siempre espera un
 * arreglo) pueda seguir leyendo filas creadas antes de esta migración sin perder datos ni
 * intentar una conversión con pérdida de píxeles a ratios (no hay forma de saber, solo con lo
 * persistido, el tamaño de la página contra la que se calcularían esos ratios).
 */
export class ArraySignatureCoordinates1784300000019 implements MigrationInterface {
  name = 'ArraySignatureCoordinates1784300000019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "simple_signatures"
      SET "signature_coordinates" = jsonb_build_array("signature_coordinates")
      WHERE jsonb_typeof("signature_coordinates") = 'object'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort: sólo desenvuelve arreglos de un solo elemento de vuelta a objeto — si para
    // entonces ya existen filas con 0 o 2+ elementos (creadas bajo el shape nuevo), esas se
    // dejan como están, porque no hay un único objeto al que puedan volver sin perder datos.
    await queryRunner.query(`
      UPDATE "simple_signatures"
      SET "signature_coordinates" = "signature_coordinates" -> 0
      WHERE jsonb_typeof("signature_coordinates") = 'array'
        AND jsonb_array_length("signature_coordinates") = 1
    `);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega `BIOMETRIC` a `document_credit_consumptions_signature_type_enum` (historia "Mostrar firma
 * biométrica en las opciones de tipo de firma").
 *
 * Desde esta historia un documento puede crearse con firma biométrica, y el recibo de crédito
 * anota con qué tipo se firma. Hasta ahora `BIOMETRIC` se anotaba como `null` porque ningún
 * documento podía nacer así; con la opción disponible, `null` diría "no se decidió" de un tipo
 * que sí se eligió. Sólo cambia la etiqueta del recibo: el crédito que se consume es el mismo.
 *
 * Sin `transaction = false`: sólo se declara el valor y ninguna sentencia escribe una fila con
 * él, así que no aplica la restricción 55P04 de Postgres (mismo criterio que
 * `AddApprovalEventTypes`).
 */
export class AddBiometricToBillingSignatureType1784300000071 implements MigrationInterface {
  name = 'AddBiometricToBillingSignatureType1784300000071';

  /**
   * Agrega el valor `BIOMETRIC` al enum del tipo de firma del recibo de crédito.
   *
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si el tipo `document_credit_consumptions_signature_type_enum` no
   *   existe.
   *
   * @example
   * ```ts
   * await new AddBiometricToBillingSignatureType1784300000071().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."document_credit_consumptions_signature_type_enum" ADD VALUE IF NOT EXISTS 'BIOMETRIC'`,
    );
  }

  /**
   * No hace nada, a propósito: Postgres no elimina un valor de enum sin recrear el tipo completo,
   * y para entonces podría haber recibos usándolo. Una etiqueta de más no afecta a ningún
   * consumidor.
   *
   * @returns Nada.
   *
   * @example
   * ```ts
   * await new AddBiometricToBillingSignatureType1784300000071().down(); // no-op
   * ```
   */
  public async down(): Promise<void> {
    // Ver el docblock: quitar un valor de enum exige recrear el tipo.
  }
}

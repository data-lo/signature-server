import { EntityManager } from 'typeorm';

import { CreditLotEntity } from './credit-lot.entity';
import { CREDIT_TYPE_ENUM } from '../enums/credit-type.enum';

/**
 * Saldo utilizable de un perfil para un tipo de crédito: `remaining - reserved` de los lotes que no
 * han caducado, con la misma regla que el consumo y la reserva.
 *
 * @param manager - Transacción en curso (o el manager por defecto para una lectura suelta).
 * @param billingProfileId - Perfil a consultar.
 * @param creditType - Tipo de crédito; por defecto, el documental.
 * @returns Créditos disponibles; `0` si no hay ningún lote vigente.
 *
 * @example
 * ```ts
 * await countAvailableCredits(manager, 'bp-1'); // 1600
 * await countAvailableCredits(manager, 'bp-1', CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE); // 20
 * ```
 */
export async function countAvailableCredits(
  manager: EntityManager,
  billingProfileId: string,
  creditType: CREDIT_TYPE_ENUM = CREDIT_TYPE_ENUM.DOCUMENT_SIGNATURE,
): Promise<number> {
  const row = await manager
    .createQueryBuilder(CreditLotEntity, 'lot')
    .select('COALESCE(SUM(lot.remaining - lot.reserved), 0)', 'available')
    .where('lot.billing_profile_id = :billingProfileId', {
      billingProfileId,
    })
    .andWhere('lot.credit_type = :creditType', { creditType })
    .andWhere('lot.remaining > lot.reserved')
    .andWhere('(lot.expires_at IS NULL OR lot.expires_at > now())')
    .getRawOne<{ available: string | number }>();

  return Number(row?.available ?? 0);
}

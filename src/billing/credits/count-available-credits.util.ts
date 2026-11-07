import { EntityManager } from 'typeorm';

import { CreditLotEntity } from './credit-lot.entity';

/**
 * Saldo utilizable de un perfil dentro de una transacción: lo que queda en lotes que no han
 * caducado, con la misma regla que `ConsumeDocumentCreditUseCase`.
 *
 * @param manager - Transacción en curso.
 * @param billingProfileId - Perfil a consultar.
 * @returns Créditos disponibles; `0` si no hay ningún lote vigente.
 *
 * @example
 * ```ts
 * await countAvailableCredits(manager, 'bp-1'); // 1600
 * ```
 */
export async function countAvailableCredits(
  manager: EntityManager,
  billingProfileId: string,
): Promise<number> {
  const row = await manager
    .createQueryBuilder(CreditLotEntity, 'lot')
    .select('COALESCE(SUM(lot.remaining), 0)', 'available')
    .where('lot.billing_profile_id = :billingProfileId', {
      billingProfileId,
    })
    .andWhere('lot.remaining > 0')
    .andWhere('(lot.expires_at IS NULL OR lot.expires_at > now())')
    .getRawOne<{ available: string | number }>();

  return Number(row?.available ?? 0);
}

import { AccountEntity } from 'src/account/entities/account.entity';
import { ACCOUNT_TYPE_ENUM } from 'src/account/enums/account-type.enum';
import { InconsistentOrganizationAccountException } from '../exceptions/billing.exceptions';

/**
 * A quién se le factura: exactamente una de las dos columnas va poblada, nunca ambas ni ninguna
 * (lo garantiza `CHK_billing_profiles_exactly_one_owner` en la tabla).
 */
export interface BillingOwner {
  personalAccountId: string | null;
  organizationId: string | null;
}

/**
 * Traduce una fila de `accounts` al propietario facturable.
 *
 * Vive en su propio archivo, sin dependencias de servicios, porque ahora hay DOS momentos que
 * necesitan esta regla y no comparten módulo: la petición HTTP que resuelve la cuenta activa
 * (`BillingOwnerService.resolveOwner`) y el alta de la cuenta, que aprovisiona su perfil Free
 * (`AccountService`). Tenerla escrita dos veces es como se llega a que un lado facture a la
 * membresía y el otro a la organización.
 *
 * La regla en sí es la que sostiene el módulo de facturación: la fila de `accounts` es una
 * MEMBRESÍA (una por usuario y por contexto), no el dueño del dinero. En PERSONAL las dos cosas
 * coinciden; en ORGANIZATION no, y facturarle a la membresía daría un perfil —y un saldo— por
 * empleado en vez del único que comparte la organización.
 *
 * ```
 * PERSONAL     → personal_account_id = account.id
 * ORGANIZATION → organization_id     = account.organization_id
 * ```
 */
export function toBillingOwner(account: AccountEntity): BillingOwner {
  if (account.accountType === ACCOUNT_TYPE_ENUM.ORGANIZATION) {
    if (!account.organizationId) {
      throw new InconsistentOrganizationAccountException(account.id);
    }

    return { personalAccountId: null, organizationId: account.organizationId };
  }

  return { personalAccountId: account.id, organizationId: null };
}

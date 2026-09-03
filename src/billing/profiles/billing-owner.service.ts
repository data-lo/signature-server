import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { ACCOUNT_TYPE_ENUM } from 'src/account/enums/account-type.enum';
import { BillingProfileEntity } from './billing-profile.entity';
import {
  InconsistentOrganizationAccountException,
  MissingActiveAccountException,
} from '../exceptions/billing.exceptions';

/**
 * A quién se le factura: exactamente una de las dos columnas va poblada, nunca ambas ni ninguna
 * (lo garantiza `CHK_billing_profiles_exactly_one_owner` en la tabla).
 */
export interface BillingOwner {
  personalAccountId: string | null;
  organizationId: string | null;
}

/**
 * Resuelve **de quién** son el dinero y el saldo, y le consigue su `billing_profile`.
 *
 * Es la distinción que sostiene el módulo: la cuenta activa (`X-Account-Id`) es una FILA DE
 * MEMBRESÍA —una por usuario y contexto, ver `AccountEntity`—, no el propietario del dinero. En
 * PERSONAL coinciden, pero en ORGANIZATION no: cada empleado tiene su fila, y facturarle a ella daría
 * un perfil y un saldo por empleado en vez del único que comparte la organización.
 *
 * ```
 * PERSONAL     → personal_account_id = account.id              (la membresía ES el tenant)
 * ORGANIZATION → organization_id     = account.organization_id (el tenant real, compartido)
 * ```
 */
@Injectable()
export class BillingOwnerService {
  private readonly logger = new Logger(BillingOwnerService.name);

  constructor(
    @InjectRepository(BillingProfileEntity)
    private readonly billingProfileRepository: Repository<BillingProfileEntity>,
    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,
  ) {}

  /**
   * Comprueba que el usuario pertenece a la cuenta activa y traduce esa cuenta al propietario
   * facturable.
   *
   * La comprobación de pertenencia no es redundante con el JWT: el header lo elige el cliente, así
   * que sin verificarlo cualquiera podría contratar y cargar saldo en nombre de una organización
   * ajena con sólo cambiar un valor en la petición.
   *
   * Consulta `accounts` directo en vez de reutilizar `AccountMemberService.assertIsActiveMember`,
   * que aplica el mismo criterio: ese servicio vive en `AccountModule`, que arrastra Kafka, roles,
   * permisos y la cadena de auditoría, y importarlo obligaría a instanciar media aplicación para
   * abrir un checkout. La fila resultante hace falta acá de todos modos, porque de ella salen
   * `accountType` y `organizationId`.
   *
   * Si el criterio de "miembro activo" cambia, hay que cambiarlo en los dos sitios.
   */
  async resolveOwner(userId: string, accountId: string): Promise<BillingOwner> {
    if (!accountId) {
      throw new MissingActiveAccountException();
    }

    const account = await this.accountRepository.findOne({
      where: { id: accountId, userId, isActive: true },
    });

    if (!account) {
      throw new ForbiddenException('No perteneces a esta cuenta');
    }

    return this.toOwner(account);
  }

  private toOwner(account: AccountEntity): BillingOwner {
    if (account.accountType === ACCOUNT_TYPE_ENUM.ORGANIZATION) {
      if (!account.organizationId) {
        throw new InconsistentOrganizationAccountException(account.id);
      }

      return {
        personalAccountId: null,
        organizationId: account.organizationId,
      };
    }

    return { personalAccountId: account.id, organizationId: null };
  }

  /** Atajo para los llamadores que sólo necesitan el perfil. */
  async resolveProfile(
    userId: string,
    accountId: string,
  ): Promise<BillingProfileEntity> {
    return this.getOrCreateProfile(await this.resolveOwner(userId, accountId));
  }

  /**
   * Devuelve el perfil del propietario, creándolo la primera vez.
   *
   * Dos miembros de la misma organización llegan con el MISMO `organizationId`, así que obtienen la
   * misma fila y comparten suscripción y saldo sin lógica adicional.
   *
   * El `catch` cubre una carrera real: `personal_account_id` y `organization_id` son únicos, y dos
   * peticiones simultáneas del mismo propietario pueden pasar ambas por el `findOne` antes de que
   * ninguna inserte. Sin él, la segunda reventaría con un error de constraint crudo cuando lo
   * correcto es justamente lo que ya ocurrió: el perfil existe.
   */
  async getOrCreateProfile(owner: BillingOwner): Promise<BillingProfileEntity> {
    const existing = await this.findByOwner(owner);
    if (existing) {
      return existing;
    }

    try {
      const created = await this.billingProfileRepository.save(
        this.billingProfileRepository.create(owner),
      );

      this.logger.log(
        `Perfil de facturación ${created.id} creado para ${this.describe(owner)}.`,
      );

      return created;
    } catch (error) {
      if (!(error instanceof QueryFailedError)) {
        throw error;
      }

      const raced = await this.findByOwner(owner);
      if (!raced) {
        throw error;
      }

      return raced;
    }
  }

  private async findByOwner(
    owner: BillingOwner,
  ): Promise<BillingProfileEntity | null> {
    return this.billingProfileRepository.findOne({
      where: owner.organizationId
        ? { organizationId: owner.organizationId }
        : { personalAccountId: owner.personalAccountId },
    });
  }

  private describe(owner: BillingOwner): string {
    return owner.organizationId
      ? `la organización ${owner.organizationId}`
      : `la cuenta personal ${owner.personalAccountId}`;
  }
}

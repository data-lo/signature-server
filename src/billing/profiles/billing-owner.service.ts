import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { BillingProfileEntity } from './billing-profile.entity';
import { toBillingOwner, type BillingOwner } from './billing-owner.util';
import { MissingActiveAccountException } from '../exceptions/billing.exceptions';

/**
 * El propietario facturable y su regla de traducción viven en `billing-owner.util`, sin
 * dependencias, porque el alta de la cuenta también los necesita y no comparte módulo con este
 * servicio. Se re-exporta para no romper a quien ya lo importaba de acá.
 */
export type { BillingOwner } from './billing-owner.util';

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

    return toBillingOwner(account);
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
    const existing = await this.findProfileByOwner(owner);
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

      const raced = await this.findProfileByOwner(owner);
      if (!raced) {
        throw error;
      }

      return raced;
    }
  }

  /**
   * Busca el perfil del propietario **sin crearlo**.
   *
   * Es la mitad de lectura de `getOrCreateProfile`, y es pública porque consultar el estado de
   * facturación no debe dar de alta nada: preguntar "¿qué plan tengo?" desde una pantalla
   * cualquiera acabaría insertando una fila en `billing_profiles` por cada cuenta que sólo
   * miró, y `null` —que es lo que el consumidor necesita distinguir— dejaría de darse nunca.
   *
   * Qué columna se consulta es justamente la distinción del módulo: `organization_id` cuando el
   * contexto es una organización (perfil compartido por todos sus miembros) y
   * `personal_account_id` cuando es una cuenta personal. El `owner` ya viene resuelto por
   * `resolveOwner`, así que acá no se vuelve a decidir de quién es el dinero.
   */
  async findProfileByOwner(
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

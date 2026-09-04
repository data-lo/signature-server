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
 * Resuelve **de quién** es el dinero y el saldo, y le consigue su `billing_profile`.
 *
 * La distinción que hace este servicio es la que sostiene todo el módulo: la cuenta activa
 * (`X-Account-Id`) es una FILA DE MEMBRESÍA —una por usuario y por contexto, ver el docblock de
 * `AccountEntity`—, no el propietario del dinero. Para una cuenta PERSONAL las dos cosas
 * coinciden, pero en una ORGANIZATION no: cada empleado tiene su propia fila en `accounts`, y
 * facturarle a esa fila daría un perfil (y un saldo de documentos) por empleado en vez del único
 * que comparte la organización.
 *
 * Por eso el propietario se resuelve así:
 *
 * ```
 * PERSONAL     → personal_account_id = account.id        (la membresía ES el tenant)
 * ORGANIZATION → organization_id     = account.organization_id  (el tenant real, compartido)
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
   * Comprueba que el usuario de verdad pertenece a la cuenta activa y traduce esa cuenta al
   * propietario facturable.
   *
   * La comprobación de pertenencia no es opcional ni redundante con el JWT: el header lo elige
   * el cliente, así que sin verificarlo cualquiera podría contratar (y cargar el saldo) en
   * nombre de una organización a la que no pertenece con sólo cambiar un valor en la petición.
   *
   * **Se consulta `accounts` directo en vez de reutilizar `AccountMemberService.assertIsActiveMember`,
   * que aplica exactamente el mismo criterio.** No es por desconocerlo: ese servicio vive en
   * `AccountModule`, que arrastra Kafka, roles, permisos de organización y la cadena de auditoría.
   * Importarlo obligaría a este módulo —que sólo necesita saber si una fila de membresía existe y
   * está activa— a instanciar media aplicación para abrir un checkout. La consulta es la misma
   * (`id` + `userId` + `isActive`) y la fila resultante hace falta aquí de todos modos, porque de
   * ella salen `accountType` y `organizationId`.
   *
   * Si el criterio de "miembro activo" cambiara, hay que cambiarlo en los dos sitios.
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
   * Dos miembros de la misma organización llegan aquí con el MISMO `organizationId`, así que
   * obtienen la misma fila y comparten suscripción y saldo sin ninguna lógica adicional.
   *
   * El `catch` no es defensivo por costumbre: `personal_account_id` y `organization_id` son
   * únicos, y dos peticiones simultáneas del mismo propietario (dos pestañas, un doble clic en
   * "Contratar") pueden pasar las dos por el `findOne` antes de que ninguna haya insertado. Sin
   * esto, la segunda reventaría con un error de constraint crudo en la cara del usuario cuando
   * lo correcto es justamente lo que ya ocurrió: el perfil existe.
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

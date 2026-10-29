import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AccountService } from 'src/account/account.service';
import { AccountEntity } from 'src/account/entities/account.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';
import { UserService } from 'src/user/user.service';

import {
  ProvisionalOwnerEmailAlreadyRegisteredException,
  ProvisionalOwnerUnavailableException,
} from '../exceptions/platform-provisioning.exceptions';

/** Identidad del propietario pedida en el aprovisionamiento. */
export interface ProvisionalOwnerIdentity {
  /** Ya normalizado (minúsculas, sin espacios). */
  email: string;
  firstName: string;
  lastName: string;
}

/** El propietario listo para recibir la organización. */
export interface ProvisionalOwner {
  user: UserEntity;
  /** Su cuenta PERSONAL. */
  personalAccount: AccountEntity;
  /** `true` si se creó en esta transacción; `false` si se reutilizó un provisional existente. */
  created: boolean;
}

/**
 * Resuelve el propietario de una cuenta provisional Enterprise, siempre como usuario `PROVISIONED`.
 *
 * - **El correo no existe:** se crea `PROVISIONED`, sin contraseña ni CURP, con su cuenta personal
 *   (`UserService.createProvisionedUser`).
 * - **Es un `PROVISIONED` activo:** se reutiliza tal cual, con su cuenta personal. Así un mismo
 *   correo de pruebas puede ser dueño de varias organizaciones provisionales, y el que dio de alta
 *   la API de integración como creador también sirve.
 * - **Es un usuario `ACTIVE`** (registrado de verdad, con contraseña): se rechaza. Una cuenta de
 *   pruebas no se cuelga de la cuenta real de una persona.
 * - **Está desactivado o borrado:** se rechaza.
 *
 * Trabaja dentro de la transacción del llamador y bloquea la fila del usuario existente.
 */
@Injectable()
export class ProvisionalOwnerProvisioningService {
  constructor(
    private readonly userService: UserService,
    private readonly accountService: AccountService,
  ) {}

  /**
   * Crea o reutiliza al propietario provisional.
   *
   * @param manager - Transacción del aprovisionamiento.
   * @param identity - Correo normalizado, nombre y apellido. En un reutilizado se ignoran el nombre
   *   y el apellido: no se reescriben los datos de un usuario existente.
   * @returns El usuario, su cuenta personal y si se creó ahora.
   *
   * @throws {ProvisionalOwnerEmailAlreadyRegisteredException} (409) Si el correo es de un usuario
   *   `ACTIVE`.
   * @throws {ProvisionalOwnerUnavailableException} (409) Si es de un usuario desactivado o borrado,
   *   o si un provisional existente no tiene cuenta personal.
   * @throws {QueryFailedError} (23505) Si otra transacción creó el mismo correo a la vez.
   *
   * @example
   * ```ts
   * const { user, personalAccount } = await owners.resolve(manager, {
   *   email: 'ana@acme.test', firstName: 'Ana', lastName: 'López',
   * });
   * ```
   */
  async resolve(
    manager: EntityManager,
    identity: ProvisionalOwnerIdentity,
  ): Promise<ProvisionalOwner> {
    const existing = await this.userService.findByEmailForUpdate(
      manager,
      identity.email,
    );

    if (!existing) {
      const { user, personalAccount } =
        await this.userService.createProvisionedUser(manager, identity);
      return { user, personalAccount, created: true };
    }

    if (existing.lifecycleStatus !== USER_LIFECYCLE_STATUS_ENUM.PROVISIONED) {
      throw new ProvisionalOwnerEmailAlreadyRegisteredException();
    }
    if (!existing.isActive || existing.isDeleted) {
      throw new ProvisionalOwnerUnavailableException();
    }

    const personalAccount = await this.accountService.findPersonalAccount(
      manager,
      existing.id,
    );
    if (!personalAccount) {
      throw new ProvisionalOwnerUnavailableException();
    }

    return { user: existing, personalAccount, created: false };
  }
}

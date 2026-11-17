import { EntityManager } from 'typeorm';

import { formatPersonName } from 'src/common/utils/format-person-name.util';

import { PersonalInformationEntity } from '../entities/personal-information.entity';
import { UserEntity } from '../entities/user.entity';
import { USER_LIFECYCLE_STATUS_ENUM } from '../enums/user-lifecycle-status.enum';
import { UserRoles } from '../enums/user-roles';

/** Lo único que se conoce de un usuario provisional al crearlo. */
export interface ProvisionedUserIdentity {
  /** Correo ya normalizado (minúsculas, sin espacios). */
  email: string;
  firstName: string;
  lastName: string;
}

/**
 * Inserta un usuario `PROVISIONED` junto con su `personal_information`, dentro de la transacción
 * del llamador. Es la única forma de crear un usuario provisional: la usan
 * `UserService.createProvisionedUser` (aprovisionamiento de la plataforma) e
 * `IntegrationCreatorService` (creadores y firmantes de la API de integración).
 *
 * **Por qué nace con información personal:** el webhook aprobado de Didit guarda las imágenes de la
 * INE en `personal_information` (`StoreVerifiedIdentityImagesUseCase`). Un provisional sin esa fila
 * hacía fallar el webhook con "el usuario no tiene información personal registrada": la
 * verificación no pasaba a `APPROVED`, la credencial no avanzaba y Didit reintentaba sin fin.
 *
 * La ficha lleva sólo nombre y apellido: un provisional no tiene CURP (`curp` en `null`) ni RFC.
 * Se completan si después activa su cuenta.
 *
 * Las dos filas se escriben con el mismo `manager`: si cualquiera falla —o el llamador revierte—
 * no queda ni la ficha ni el usuario.
 *
 * @param manager - Transacción en curso.
 * @param identity - Correo normalizado, nombre y apellido.
 * @returns El usuario creado, ya enlazado a su información personal.
 *
 * @throws {QueryFailedError} (23505) Si otra transacción registró el mismo correo a la vez.
 *
 * @example
 * ```ts
 * const user = await insertProvisionedUser(manager, {
 *   email: 'ana@acme.test', firstName: 'ana', lastName: 'lópez',
 * });
 * user.personalInformationId; // uuid de su ficha
 * ```
 */
export async function insertProvisionedUser(
  manager: EntityManager,
  identity: ProvisionedUserIdentity,
): Promise<UserEntity> {
  const firstName = formatPersonName(identity.firstName);
  const lastName = formatPersonName(identity.lastName);

  const personalInformationRepository = manager.getRepository(
    PersonalInformationEntity,
  );
  const personalInformation = await personalInformationRepository.save(
    personalInformationRepository.create({
      name: firstName,
      lastName,
      curp: null,
      rfc: null,
    }),
  );

  const userRepository = manager.getRepository(UserEntity);
  return userRepository.save(
    userRepository.create({
      firstName,
      lastName,
      email: identity.email,
      roles: [UserRoles.SIGNER],
      lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
      nationalId: null,
      password: null,
      personalInformationId: personalInformation.id,
      isEmailVerified: false,
    }),
  );
}

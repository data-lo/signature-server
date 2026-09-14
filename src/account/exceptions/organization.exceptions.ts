import {
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';

/**
 * No se pudo dejar al creador como administrador de la organización que estaba creando.
 *
 * La causa que se ha visto en la práctica es el RBAC sin sembrar: `findSystemRoleByName` no
 * encuentra el rol de sistema ADMIN y responde con instrucciones de operación ("corre
 * npm run seed:roles"), un mensaje que no le sirve de nada a quien está llenando el formulario
 * y que además cuenta cómo está montado el sistema por dentro.
 *
 * Lo importante para quien lo lee es otra cosa: **no quedó nada a medias**. El alta entera va en
 * una transacción, así que si la asignación del administrador no se puede completar no hay
 * organización huérfana ni membresía suelta, y reintentar es seguro. El detalle técnico se
 * queda en el log del servidor, donde sí puede accionarse.
 *
 * @example
 * ```ts
 * throw new OrganizationAdminAssignmentFailedException();
 * ```
 */
export class OrganizationAdminAssignmentFailedException extends InternalServerErrorException {
  constructor() {
    super(
      'No se pudo asignar al administrador de la organización, así que no se creó. Vuelve a intentarlo.',
    );
  }
}

/** Código SQLSTATE de Postgres para la violación de una restricción única. */
const POSTGRES_UNIQUE_VIOLATION = '23505';

/** Nombre del índice que garantiza una sola membresía por (usuario × organización). */
const UNIQUE_MEMBERSHIP_INDEX = 'UQ_accounts_user_id_organization_id';

/**
 * Alguien ya tiene una membresía en esa organización.
 *
 * Es el mismo 409 que responden las comprobaciones previas de `AddOrganizationMemberUseCase` y
 * `finalizeAcceptance`; existe para el caso que esas comprobaciones no pueden cubrir: dos
 * peticiones simultáneas que leen "no existe" a la vez y las dos insertan. La segunda choca
 * contra el índice único de la base y sin esto saldría como un 500 con texto de Postgres.
 *
 * @example
 * ```ts
 * throw new DuplicateOrganizationMembershipException();
 * ```
 */
export class DuplicateOrganizationMembershipException extends ConflictException {
  constructor() {
    super('Esta persona ya tiene una membresía en la organización');
  }
}

/**
 * Reconoce el choque contra el índice único de membresías.
 *
 * Mira el código SQLSTATE y el nombre del índice, no el texto del mensaje: el texto depende del
 * idioma con el que arrancó Postgres, y cualquier otra restricción única de `accounts` que se
 * agregue mañana no debe confundirse con ésta.
 *
 * @param error - Lo que sea que haya lanzado el driver.
 * @returns `true` si es una membresía duplicada de (usuario × organización).
 *
 * @example
 * ```ts
 * try {
 *   await repository.save(membership);
 * } catch (error) {
 *   if (isDuplicateMembershipError(error)) {
 *     throw new DuplicateOrganizationMembershipException();
 *   }
 *   throw error;
 * }
 * ```
 */
export function isDuplicateMembershipError(error: unknown): boolean {
  const driverError = error as {
    code?: string;
    constraint?: string;
    driverError?: { code?: string; constraint?: string };
  };
  const code = driverError?.code ?? driverError?.driverError?.code;
  const constraint =
    driverError?.constraint ?? driverError?.driverError?.constraint;

  return (
    code === POSTGRES_UNIQUE_VIOLATION && constraint === UNIQUE_MEMBERSHIP_INDEX
  );
}

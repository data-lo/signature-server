import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';

/**
 * Solicitudes que el controller arma para los casos de uso del directorio.
 *
 * Son interfaces planas, no los DTOs de `class-validator`: el controller traduce lo que recibió
 * (header, ruta, query, cuerpo) a estos contratos, y los casos de uso no conocen ni el
 * `ValidationPipe` ni la forma de la petición HTTP. Ninguna trae el directorio: sale de `actor`.
 */

/** Quién hace la petición y en qué cuenta, tal como lo dejó `PermissionsGuard`. */
export interface DirectoryActor {
  /** Contexto autorizado de la petición. */
  authorization: AuthorizationContext;
  /** Valor del header `X-Account-Id`; `undefined` si no llegó. */
  activeAccountId: string | undefined;
}

/** Entrada de `ListDirectoryContactsUseCase`. */
export interface ListDirectoryContactsRequest {
  actor: DirectoryActor;
  /** Texto libre ya recortado; `undefined` lista todo. */
  search?: string;
  /** Página base 1. */
  page: number;
  /** Resultados por página. */
  limit: number;
}

/** Datos de un contacto nuevo, tal como los capturó el cliente (sin normalizar). */
export interface NewDirectoryContactInput {
  firstName: string;
  lastName: string;
  email: string;
  taxId?: string | null;
  phone?: string | null;
}

/** Entrada de `CreateDirectoryContactUseCase`. */
export interface CreateDirectoryContactRequest {
  actor: DirectoryActor;
  contact: NewDirectoryContactInput;
}

/**
 * Cambios a un contacto: `undefined` deja el campo como está; `null` vacía `taxId` o `phone`.
 */
export interface DirectoryContactChanges {
  firstName?: string;
  lastName?: string;
  email?: string;
  taxId?: string | null;
  phone?: string | null;
}

/** Entrada de `UpdateDirectoryContactUseCase`. */
export interface UpdateDirectoryContactRequest {
  actor: DirectoryActor;
  contactId: string;
  changes: DirectoryContactChanges;
}

/** Entrada de `ArchiveDirectoryContactUseCase`. */
export interface ArchiveDirectoryContactRequest {
  actor: DirectoryActor;
  contactId: string;
}

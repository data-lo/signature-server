/**
 * Contratos de la capa de datos del directorio (`DirectoryService`).
 *
 * Son los únicos tipos que cruzan entre los casos de uso y el acceso a datos: ya normalizados y
 * sin nada de HTTP. Los casos de uso deciden QUÉ se guarda; el servicio sólo sabe CÓMO.
 */

/** El dueño del directorio: exactamente una de las dos columnas, como exige `CHK_directories_single_owner`. */
export type DirectoryOwner =
  | { personalAccountId: string; organizationId: null }
  | { personalAccountId: null; organizationId: string };

/** Filtro y página de la consulta de contactos vigentes de un directorio. */
export interface ActiveDirectoryContactsQuery {
  directoryId: string;
  /** Texto libre, sin escapar; `undefined` lista todo. */
  search?: string;
  /** Filas a saltar. */
  skip: number;
  /** Filas a devolver. */
  take: number;
}

/** Campos editables de un contacto, ya normalizados. */
export interface DirectoryContactFields {
  firstName: string;
  lastName: string;
  /** RFC en mayúsculas, o `null` si no tiene. */
  taxId: string | null;
  phone: string | null;
}

/** Fila nueva de `directory_contacts`, con la autoría ya resuelta. */
export interface NewDirectoryContactData extends DirectoryContactFields {
  directoryId: string;
  /** Correo ya normalizado (`normalizeContactEmail`). */
  emailNormalized: string;
  createdByAccountId: string;
  updatedByAccountId: string;
}

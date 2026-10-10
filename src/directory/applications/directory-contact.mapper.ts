import { DirectoryContactEntity } from '../entities/directory-contact.entity';
import { DirectoryContactResponse } from '../interfaces/response/directory-contact-response';

/**
 * Traduce la entidad a la forma pública, con el correo normalizado como `email`.
 *
 * Es la única frontera entre la fila de `directory_contacts` y lo que publica la API: columnas
 * internas como `directoryId` o la autoría nunca salen del servidor.
 *
 * @param contact - Contacto guardado.
 * @returns El contacto como lo publica la API.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * toDirectoryContactResponse(contact).email; // 'ana@example.com'
 * ```
 */
export function toDirectoryContactResponse(
  contact: DirectoryContactEntity,
): DirectoryContactResponse {
  return {
    id: contact.id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.emailNormalized,
    taxId: contact.taxId ?? null,
    phone: contact.phone ?? null,
    linkedPersonalAccountId: contact.linkedPersonalAccountId ?? null,
    archivedAt: contact.archivedAt ?? null,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  };
}

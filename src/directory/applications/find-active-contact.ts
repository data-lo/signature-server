import { DirectoryService } from '../directory.service';
import { DirectoryContactEntity } from '../entities/directory-contact.entity';
import { DirectoryContactNotFoundException } from '../exceptions/directory.exceptions';
import { DirectoryActor } from '../interfaces/request/directory-contact-request';
import { resolveDirectoryOwner } from './resolve-directory-owner';

/**
 * Busca un contacto vigente DENTRO del directorio de la cuenta activa.
 *
 * Conocer el `contactId` de otro directorio no sirve de nada: la búsqueda va acotada al
 * directorio resuelto desde `actor`, y lo ajeno, lo inexistente y lo archivado responden igual.
 * Si la cuenta todavía no tiene directorio, responde 404 sin crearlo.
 *
 * @param directoryService - Acceso a datos del directorio.
 * @param actor - Contexto autorizado y header `X-Account-Id` de la petición.
 * @param contactId - Contacto buscado.
 * @returns El contacto vigente.
 *
 * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
 * @throws {ForbiddenException} (403) Si `X-Account-Id` no es la cuenta que se autorizó.
 * @throws {DirectoryContactNotFoundException} (404) Si no hay directorio, o el contacto no existe
 *   en él, o está archivado.
 *
 * @example
 * ```ts
 * const contact = await findActiveContactOrFail(directoryService, actor, 'contact-1');
 * ```
 */
export async function findActiveContactOrFail(
  directoryService: DirectoryService,
  actor: DirectoryActor,
  contactId: string,
): Promise<DirectoryContactEntity> {
  const directory = await directoryService.findDirectory(
    resolveDirectoryOwner(actor),
  );
  const contact = directory
    ? await directoryService.findActiveContact(directory.id, contactId)
    : null;

  if (!contact) {
    throw new DirectoryContactNotFoundException();
  }

  return contact;
}

import { Injectable } from '@nestjs/common';

import { DirectoryService } from '../directory.service';
import { ArchiveDirectoryContactRequest } from '../interfaces/request/directory-contact-request';
import { DirectoryContactResponse } from '../interfaces/response/directory-contact-response';
import { toDirectoryContactResponse } from './directory-contact.mapper';
import { findActiveContactOrFail } from './find-active-contact';

/**
 * `DELETE /directory/contacts/:contactId`: archivado (borrado lógico) de un contacto.
 *
 * Fija `archivedAt` y `updatedByAccountId`; la fila se conserva. Archivar dos veces responde 404,
 * porque un contacto archivado ya no es visible.
 */
@Injectable()
export class ArchiveDirectoryContactUseCase {
  constructor(private readonly directoryService: DirectoryService) {}

  /**
   * Archiva un contacto vigente del directorio de la cuenta activa.
   *
   * @param request - Cuenta activa y contacto a archivar.
   * @returns El contacto ya archivado.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si `X-Account-Id` no es la cuenta que se autorizó.
   * @throws {DirectoryContactNotFoundException} (404) Si el contacto no existe, es de otro
   *   directorio o ya está archivado.
   *
   * @example
   * ```ts
   * const archived = await archiveDirectoryContact.execute({
   *   actor: { authorization, activeAccountId: 'acc-1' },
   *   contactId: 'contact-1',
   * });
   * archived.archivedAt; // Date
   * ```
   */
  async execute({
    actor,
    contactId,
  }: ArchiveDirectoryContactRequest): Promise<DirectoryContactResponse> {
    const contact = await findActiveContactOrFail(
      this.directoryService,
      actor,
      contactId,
    );

    contact.archivedAt = new Date();
    contact.updatedByAccountId = actor.authorization.accountId;

    return toDirectoryContactResponse(
      await this.directoryService.saveContact(contact),
    );
  }
}

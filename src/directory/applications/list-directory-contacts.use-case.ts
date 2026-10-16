import { Injectable } from '@nestjs/common';

import { DirectoryService } from '../directory.service';
import { ListDirectoryContactsRequest } from '../interfaces/request/directory-contact-request';
import { DirectoryContactListResponse } from '../interfaces/response/directory-contact-response';
import { toDirectoryContactResponse } from './directory-contact.mapper';
import { resolveDirectoryOwner } from './resolve-directory-owner';

/**
 * `GET /directory/contacts`: contactos vigentes del directorio activo, paginados.
 *
 * Los directorios se crean al dar de alta el primer contacto, no antes: leer un directorio que
 * todavía no existe responde la página vacía sin escribir nada.
 */
@Injectable()
export class ListDirectoryContactsUseCase {
  constructor(private readonly directoryService: DirectoryService) {}

  /**
   * Lista, paginados, los contactos vigentes del directorio de la cuenta activa.
   *
   * @param request - Cuenta activa, búsqueda y paginación.
   * @returns La página pedida y su paginación; vacía si la cuenta todavía no tiene directorio.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si `X-Account-Id` no es la cuenta que se autorizó.
   *
   * @example
   * ```ts
   * const { items, pagination } = await listDirectoryContacts.execute({
   *   actor: { authorization, activeAccountId: 'acc-1' },
   *   search: 'garcía',
   *   page: 1,
   *   limit: 25,
   * });
   * ```
   */
  async execute({
    actor,
    search,
    page,
    limit,
  }: ListDirectoryContactsRequest): Promise<DirectoryContactListResponse> {
    const directory = await this.directoryService.findDirectory(
      resolveDirectoryOwner(actor),
    );

    if (!directory) {
      return {
        items: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
      };
    }

    const [contacts, total] = await this.directoryService.findActiveContacts({
      directoryId: directory.id,
      search,
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      items: contacts.map(toDirectoryContactResponse),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}

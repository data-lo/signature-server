import { Injectable } from '@nestjs/common';

import { DirectoryService } from '../directory.service';
import { DirectoryContactEmailTakenException } from '../exceptions/directory.exceptions';
import { DirectoryContactFields } from '../interfaces/directory-data';
import { CreateDirectoryContactRequest } from '../interfaces/request/directory-contact-request';
import { DirectoryContactResponse } from '../interfaces/response/directory-contact-response';
import {
  normalizeContactEmail,
  normalizeContactTaxId,
} from '../utils/directory-contact.utils';
import { toDirectoryContactResponse } from './directory-contact.mapper';
import { resolveDirectoryOwner } from './resolve-directory-owner';

/**
 * `POST /directory/contacts`: alta de un contacto en el directorio activo.
 *
 * El correo se normaliza y es único por directorio. Si ya existe un contacto vigente con ese
 * correo, responde 409. Si existe pero está archivado, lo **reactiva** con los datos nuevos en
 * lugar de rechazarlo: la restricción única también cubre a los archivados, así que de otro modo
 * un correo archivado no podría volver a darse de alta nunca. La autoría
 * (`createdByAccountId`/`updatedByAccountId`) es la membresía autorizada, nunca un dato del
 * cliente.
 */
@Injectable()
export class CreateDirectoryContactUseCase {
  constructor(private readonly directoryService: DirectoryService) {}

  /**
   * Da de alta un contacto en el directorio de la cuenta activa, creando el directorio si falta.
   *
   * @param request - Cuenta activa y datos del contacto.
   * @returns El contacto creado o reactivado.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si `X-Account-Id` no es la cuenta que se autorizó.
   * @throws {DirectoryContactEmailTakenException} (409) Si ya hay un contacto vigente con ese
   *   correo, también cuando otra petición lo dio de alta al mismo tiempo.
   *
   * @example
   * ```ts
   * const contact = await createDirectoryContact.execute({
   *   actor: { authorization, activeAccountId: 'acc-1' },
   *   contact: { firstName: 'Ana', lastName: 'García', email: 'Ana@Example.com' },
   * });
   * contact.email; // 'ana@example.com'
   * ```
   */
  async execute({
    actor,
    contact,
  }: CreateDirectoryContactRequest): Promise<DirectoryContactResponse> {
    const directory = await this.directoryService.findOrCreateDirectory(
      resolveDirectoryOwner(actor),
    );
    const authorAccountId = actor.authorization.accountId;
    const emailNormalized = normalizeContactEmail(contact.email);
    const fields: DirectoryContactFields = {
      firstName: contact.firstName,
      lastName: contact.lastName,
      taxId: normalizeContactTaxId(contact.taxId) ?? null,
      phone: contact.phone ?? null,
    };

    const existing = await this.directoryService.findContactByEmail(
      directory.id,
      emailNormalized,
    );

    if (existing && !existing.archivedAt) {
      throw new DirectoryContactEmailTakenException();
    }

    const saved = existing
      ? await this.directoryService.saveContact(
          Object.assign(existing, fields, {
            archivedAt: null,
            updatedByAccountId: authorAccountId,
          }),
        )
      : await this.directoryService.createContact({
          ...fields,
          directoryId: directory.id,
          emailNormalized,
          createdByAccountId: authorAccountId,
          updatedByAccountId: authorAccountId,
        });

    return toDirectoryContactResponse(saved);
  }
}

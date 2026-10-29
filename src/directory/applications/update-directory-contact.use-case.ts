import { Injectable } from '@nestjs/common';

import { DirectoryService } from '../directory.service';
import { DirectoryContactEmailTakenException } from '../exceptions/directory.exceptions';
import { UpdateDirectoryContactRequest } from '../interfaces/request/directory-contact-request';
import { DirectoryContactResponse } from '../interfaces/response/directory-contact-response';
import {
  normalizeContactEmail,
  normalizeContactTaxId,
} from '../utils/directory-contact.utils';
import { toDirectoryContactResponse } from './directory-contact.mapper';
import { findActiveContactOrFail } from './find-active-contact';

/**
 * `PATCH /directory/contacts/:contactId`: edición de un contacto vigente del directorio activo.
 *
 * Sólo cambia lo que llega. Si cambia el correo, se normaliza y se comprueba que no lo use otro
 * contacto del directorio, vigente o archivado (los dos ocupan la restricción única). Registra la
 * membresía autorizada como `updatedByAccountId`.
 */
@Injectable()
export class UpdateDirectoryContactUseCase {
  constructor(private readonly directoryService: DirectoryService) {}

  /**
   * Actualiza un contacto vigente del directorio de la cuenta activa.
   *
   * @param request - Cuenta activa, contacto y cambios.
   * @returns El contacto actualizado.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si `X-Account-Id` no es la cuenta que se autorizó.
   * @throws {DirectoryContactNotFoundException} (404) Si el contacto no existe, es de otro
   *   directorio o está archivado.
   * @throws {DirectoryContactEmailTakenException} (409) Si el correo nuevo ya lo usa otro contacto
   *   del directorio.
   *
   * @example
   * ```ts
   * await updateDirectoryContact.execute({
   *   actor: { authorization, activeAccountId: 'acc-1' },
   *   contactId: 'contact-1',
   *   changes: { phone: '+526141234567' },
   * });
   * ```
   */
  async execute({
    actor,
    contactId,
    changes,
  }: UpdateDirectoryContactRequest): Promise<DirectoryContactResponse> {
    const contact = await findActiveContactOrFail(
      this.directoryService,
      actor,
      contactId,
    );

    if (changes.email !== undefined) {
      const emailNormalized = normalizeContactEmail(changes.email);
      if (emailNormalized !== contact.emailNormalized) {
        const taken = await this.directoryService.isEmailTaken(
          contact.directoryId,
          emailNormalized,
        );
        if (taken) {
          throw new DirectoryContactEmailTakenException();
        }
        contact.emailNormalized = emailNormalized;
      }
    }

    if (changes.firstName !== undefined) contact.firstName = changes.firstName;
    if (changes.lastName !== undefined) contact.lastName = changes.lastName;
    if (changes.taxId !== undefined) {
      contact.taxId = normalizeContactTaxId(changes.taxId) ?? null;
    }
    if (changes.phone !== undefined) contact.phone = changes.phone;
    contact.updatedByAccountId = actor.authorization.accountId;

    return toDirectoryContactResponse(
      await this.directoryService.saveContact(contact),
    );
  }
}

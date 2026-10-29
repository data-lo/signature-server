import { ConflictException, NotFoundException } from '@nestjs/common';

/**
 * El correo ya lo usa otro contacto del directorio, vigente o archivado: los dos ocupan
 * `UQ_directory_contacts_directory_email`.
 *
 * @example
 * ```ts
 * throw new DirectoryContactEmailTakenException();
 * ```
 */
export class DirectoryContactEmailTakenException extends ConflictException {
  constructor() {
    super('Ya existe un contacto con ese correo en el directorio');
  }
}

/**
 * El contacto no está vigente en el directorio activo. Lo ajeno, lo inexistente y lo archivado
 * responden lo mismo: decir "existe, pero no es tuyo" confirmaría a otra cuenta que existe.
 *
 * @example
 * ```ts
 * throw new DirectoryContactNotFoundException();
 * ```
 */
export class DirectoryContactNotFoundException extends NotFoundException {
  constructor() {
    super('Contacto no encontrado');
  }
}

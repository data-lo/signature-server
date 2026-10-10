import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, QueryFailedError, Repository } from 'typeorm';

import { DirectoryEntity } from './entities/directory.entity';
import { DirectoryContactEntity } from './entities/directory-contact.entity';
import { DirectoryContactEmailTakenException } from './exceptions/directory.exceptions';
import {
  ActiveDirectoryContactsQuery,
  DirectoryOwner,
  NewDirectoryContactData,
} from './interfaces/directory-data';
import { escapeLikePattern } from './utils/directory-contact.utils';

/** Código de Postgres para la violación de una restricción `UNIQUE`. */
const UNIQUE_VIOLATION = '23505';

/** Restricción que hace único el correo dentro de un directorio (ver `CreateDirectories`). */
const UNIQUE_EMAIL_CONSTRAINT = 'UQ_directory_contacts_directory_email';

/**
 * Acceso a datos del directorio: `directories` y `directory_contacts`.
 *
 * No decide nada: no resuelve la cuenta activa, no normaliza, no valida duplicados ni sabe de
 * archivado más allá de filtrar por `archived_at`. Recibe datos ya resueltos por los casos de uso
 * (`applications/`) y devuelve entidades. Lo único que traduce es el choque con la unicidad del
 * correo, porque sólo la base puede detectarlo cuando dos altas compiten.
 */
@Injectable()
export class DirectoryService {
  constructor(
    @InjectRepository(DirectoryEntity)
    private readonly directoryRepository: Repository<DirectoryEntity>,
    @InjectRepository(DirectoryContactEntity)
    private readonly contactRepository: Repository<DirectoryContactEntity>,
  ) {}

  /**
   * Busca el directorio de un dueño, sin crearlo.
   *
   * @param owner - Cuenta personal u organización.
   * @returns El directorio, o `null` si todavía no existe.
   *
   * @throws Nada propio; los errores de la base se propagan.
   *
   * @example
   * ```ts
   * const directory = await directoryService.findDirectory({
   *   personalAccountId: 'acc-1',
   *   organizationId: null,
   * });
   * ```
   */
  findDirectory(owner: DirectoryOwner): Promise<DirectoryEntity | null> {
    return this.directoryRepository.findOne({
      where: this.ownerWhere(owner),
    });
  }

  /**
   * Devuelve el directorio de un dueño, creándolo si falta, sin carreras.
   *
   * Inserta con `ON CONFLICT DO NOTHING` y después lee: si dos miembros de la misma organización
   * dan de alta su primer contacto a la vez, uno inserta, el otro choca con
   * `UQ_directories_organization_id` sin error, y los dos leen la misma fila.
   *
   * @param owner - Cuenta personal u organización.
   * @returns El directorio del dueño.
   *
   * @throws {EntityNotFoundError} Sólo si la fila desapareció entre el insert y la lectura (el
   *   dueño se borró en ese instante).
   *
   * @example
   * ```ts
   * const directory = await directoryService.findOrCreateDirectory({
   *   personalAccountId: null,
   *   organizationId: 'org-1',
   * });
   * ```
   */
  async findOrCreateDirectory(owner: DirectoryOwner): Promise<DirectoryEntity> {
    await this.directoryRepository
      .createQueryBuilder()
      .insert()
      .into(DirectoryEntity)
      .values(owner)
      .orIgnore()
      .execute();

    return this.directoryRepository.findOneOrFail({
      where: this.ownerWhere(owner),
    });
  }

  /**
   * Lee una página de contactos vigentes (sin archivar) de un directorio.
   *
   * La búsqueda compara por subcadena, sin distinguir mayúsculas, contra el nombre, el apellido,
   * el nombre completo, el correo y el RFC, con los comodines de `LIKE` escapados. Ordena por
   * apellido, nombre e id para que la paginación sea estable.
   *
   * @param query - Directorio, búsqueda y ventana de filas.
   * @returns Los contactos de la ventana y el total que cumple el filtro.
   *
   * @throws Nada propio; los errores de la base se propagan.
   *
   * @example
   * ```ts
   * const [contacts, total] = await directoryService.findActiveContacts({
   *   directoryId: 'directory-1',
   *   search: 'garcía',
   *   skip: 0,
   *   take: 25,
   * });
   * ```
   */
  findActiveContacts(
    query: ActiveDirectoryContactsQuery,
  ): Promise<[DirectoryContactEntity[], number]> {
    const qb = this.contactRepository
      .createQueryBuilder('contact')
      .where('contact.directoryId = :directoryId', {
        directoryId: query.directoryId,
      })
      .andWhere('contact.archivedAt IS NULL');

    if (query.search) {
      qb.andWhere(
        `(contact.firstName ILIKE :search
          OR contact.lastName ILIKE :search
          OR CONCAT(contact.firstName, ' ', contact.lastName) ILIKE :search
          OR contact.emailNormalized ILIKE :search
          OR contact.taxId ILIKE :search)`,
        { search: `%${escapeLikePattern(query.search)}%` },
      );
    }

    return qb
      .orderBy('contact.lastName', 'ASC')
      .addOrderBy('contact.firstName', 'ASC')
      .addOrderBy('contact.id', 'ASC')
      .skip(query.skip)
      .take(query.take)
      .getManyAndCount();
  }

  /**
   * Busca un contacto vigente DENTRO de un directorio.
   *
   * @param directoryId - Directorio que acota la búsqueda.
   * @param contactId - Contacto buscado.
   * @returns El contacto, o `null` si no existe en ese directorio o está archivado.
   *
   * @throws Nada propio; los errores de la base se propagan.
   *
   * @example
   * ```ts
   * const contact = await directoryService.findActiveContact('directory-1', 'contact-1');
   * ```
   */
  findActiveContact(
    directoryId: string,
    contactId: string,
  ): Promise<DirectoryContactEntity | null> {
    return this.contactRepository.findOne({
      where: { id: contactId, directoryId, archivedAt: IsNull() },
    });
  }

  /**
   * Busca el contacto de un directorio con un correo, vigente o archivado.
   *
   * @param directoryId - Directorio que acota la búsqueda.
   * @param emailNormalized - Correo ya normalizado.
   * @returns El contacto, o `null` si el correo está libre.
   *
   * @throws Nada propio; los errores de la base se propagan.
   *
   * @example
   * ```ts
   * const existing = await directoryService.findContactByEmail('directory-1', 'ana@example.com');
   * ```
   */
  findContactByEmail(
    directoryId: string,
    emailNormalized: string,
  ): Promise<DirectoryContactEntity | null> {
    return this.contactRepository.findOne({
      where: { directoryId, emailNormalized },
    });
  }

  /**
   * Indica si algún contacto del directorio, vigente o archivado, usa ese correo.
   *
   * @param directoryId - Directorio que acota la búsqueda.
   * @param emailNormalized - Correo ya normalizado.
   * @returns `true` si el correo está ocupado.
   *
   * @throws Nada propio; los errores de la base se propagan.
   *
   * @example
   * ```ts
   * if (await directoryService.isEmailTaken('directory-1', 'ana@example.com')) { … }
   * ```
   */
  isEmailTaken(directoryId: string, emailNormalized: string): Promise<boolean> {
    return this.contactRepository.exists({
      where: { directoryId, emailNormalized },
    });
  }

  /**
   * Inserta un contacto nuevo.
   *
   * @param data - Fila completa, ya normalizada y con la autoría resuelta.
   * @returns El contacto guardado, con `id` y fechas.
   *
   * @throws {DirectoryContactEmailTakenException} (409) Si la base rechaza el correo por duplicado.
   * @throws {QueryFailedError} Cualquier otro error de la base, sin traducir.
   *
   * @example
   * ```ts
   * const saved = await directoryService.createContact({
   *   directoryId: 'directory-1',
   *   emailNormalized: 'ana@example.com',
   *   firstName: 'Ana',
   *   lastName: 'García',
   *   taxId: null,
   *   phone: null,
   *   createdByAccountId: 'acc-1',
   *   updatedByAccountId: 'acc-1',
   * });
   * ```
   */
  createContact(
    data: NewDirectoryContactData,
  ): Promise<DirectoryContactEntity> {
    return this.saveContact(this.contactRepository.create(data));
  }

  /**
   * Guarda los cambios de un contacto existente y traduce a 409 el choque con la unicidad del
   * correo.
   *
   * La comprobación previa de los casos de uso cubre el caso normal; esto cubre la carrera de dos
   * escrituras simultáneas del mismo correo, en la que las dos pasan la comprobación y sólo una
   * puede guardar.
   *
   * @param contact - Contacto a guardar.
   * @returns El contacto guardado.
   *
   * @throws {DirectoryContactEmailTakenException} (409) Si la base rechaza el correo por duplicado.
   * @throws {QueryFailedError} Cualquier otro error de la base, sin traducir.
   *
   * @example
   * ```ts
   * contact.phone = '+526141234567';
   * const saved = await directoryService.saveContact(contact);
   * ```
   */
  async saveContact(
    contact: DirectoryContactEntity,
  ): Promise<DirectoryContactEntity> {
    try {
      return await this.contactRepository.save(contact);
    } catch (error) {
      const driverError = (
        error as QueryFailedError & {
          driverError?: { code?: string; constraint?: string };
        }
      ).driverError;
      if (
        error instanceof QueryFailedError &&
        driverError?.code === UNIQUE_VIOLATION &&
        driverError.constraint === UNIQUE_EMAIL_CONSTRAINT
      ) {
        throw new DirectoryContactEmailTakenException();
      }
      throw error;
    }
  }

  /**
   * Arma el `where` que identifica el directorio de un dueño.
   *
   * @param owner - Cuenta personal u organización.
   * @returns El filtro por la columna que corresponde.
   *
   * @throws Nada.
   *
   * @example
   * ```ts
   * this.ownerWhere({ personalAccountId: null, organizationId: 'org-1' });
   * // { organizationId: 'org-1' }
   * ```
   */
  private ownerWhere(
    owner: DirectoryOwner,
  ): { organizationId: string } | { personalAccountId: string } {
    return owner.organizationId
      ? { organizationId: owner.organizationId }
      : { personalAccountId: owner.personalAccountId! };
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, QueryFailedError, Repository } from 'typeorm';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';

import { DirectoryEntity } from './entities/directory.entity';
import { DirectoryContactEntity } from './entities/directory-contact.entity';
import { CreateDirectoryContactDto } from './dto/create-directory-contact.dto';
import { UpdateDirectoryContactDto } from './dto/update-directory-contact.dto';
import { ListDirectoryContactsDto } from './dto/list-directory-contacts.dto';
import {
  DirectoryContactListResponse,
  DirectoryContactResponse,
} from './interfaces/response/directory-contact-response';

/** Código de Postgres para la violación de una restricción `UNIQUE`. */
const UNIQUE_VIOLATION = '23505';

/** Restricción que hace único el correo dentro de un directorio (ver `CreateDirectories`). */
const UNIQUE_EMAIL_CONSTRAINT = 'UQ_directory_contacts_directory_email';

const DUPLICATE_EMAIL_MESSAGE =
  'Ya existe un contacto con ese correo en el directorio';

const CONTACT_NOT_FOUND_MESSAGE = 'Contacto no encontrado';

/** El dueño del directorio: exactamente una de las dos columnas, como exige `CHK_directories_single_owner`. */
type DirectoryOwner =
  | { personalAccountId: string; organizationId: null }
  | { personalAccountId: null; organizationId: string };

/**
 * Normaliza el correo de un contacto: es la forma en la que se guarda y con la que se compara.
 *
 * @param email - Correo tal como llegó.
 * @returns El correo sin espacios en los extremos y en minúsculas.
 *
 * @example
 * ```ts
 * normalizeContactEmail('  Ana@Example.com '); // 'ana@example.com'
 * ```
 */
export function normalizeContactEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Normaliza el RFC de un contacto a mayúsculas, conservando `null` y `undefined`.
 *
 * @param taxId - RFC ya recortado por el DTO, `null` para vaciarlo o `undefined` si no vino.
 * @returns El RFC en mayúsculas, o el mismo `null`/`undefined`.
 *
 * @example
 * ```ts
 * normalizeContactTaxId('gaaa900101xxx'); // 'GAAA900101XXX'
 * ```
 */
export function normalizeContactTaxId(
  taxId: string | null | undefined,
): string | null | undefined {
  return typeof taxId === 'string' ? taxId.toUpperCase() : taxId;
}

/**
 * Escapa los comodines de `LIKE` (`%`, `_` y `\`) para buscar el texto tal cual.
 *
 * @param term - Texto de búsqueda.
 * @returns El texto con los comodines escapados.
 *
 * @example
 * ```ts
 * escapeLikePattern('50%_off'); // '50\\%\\_off'
 * ```
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Contactos del directorio de la cuenta activa.
 *
 * El directorio NUNCA lo elige el cliente: sale del contexto que dejó `PermissionsGuard`. Una
 * cuenta PERSONAL usa el directorio de su `accounts.id`; una de ORGANIZATION, el de su
 * `organizationId`, el mismo para todos los miembros. Por eso conocer el `contactId` de otro
 * directorio no sirve de nada: toda búsqueda de un contacto va acotada al directorio resuelto, y
 * lo ajeno responde 404 igual que lo inexistente.
 *
 * Los directorios se crean al dar de alta el primer contacto, no antes: leer un directorio que
 * todavía no existe responde la lista vacía sin escribir nada.
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
   * Lista, paginados, los contactos vigentes del directorio de la cuenta activa.
   *
   * Excluye los archivados. La búsqueda compara por subcadena, sin distinguir mayúsculas, contra
   * el nombre, el apellido, el nombre completo, el correo y el RFC. Ordena por apellido, nombre e
   * id para que la paginación sea estable.
   *
   * @param authorization - Contexto autorizado de la petición.
   * @param activeAccountId - Valor del header `X-Account-Id`.
   * @param query - Búsqueda y paginación.
   * @returns La página pedida y su paginación; vacía si la cuenta todavía no tiene directorio.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si `X-Account-Id` no es la cuenta que se autorizó.
   *
   * @example
   * ```ts
   * const { items, pagination } = await directoryService.listContacts(authorization, 'acc-1', {
   *   search: 'garcía',
   *   page: 1,
   *   limit: 25,
   * });
   * ```
   */
  async listContacts(
    authorization: AuthorizationContext,
    activeAccountId: string | undefined,
    query: ListDirectoryContactsDto,
  ): Promise<DirectoryContactListResponse> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const directory = await this.findDirectory(
      this.resolveOwner(authorization, activeAccountId),
    );

    if (!directory) {
      return {
        items: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
      };
    }

    const qb = this.contactRepository
      .createQueryBuilder('contact')
      .where('contact.directoryId = :directoryId', {
        directoryId: directory.id,
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

    const [contacts, total] = await qb
      .orderBy('contact.lastName', 'ASC')
      .addOrderBy('contact.firstName', 'ASC')
      .addOrderBy('contact.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      items: contacts.map((contact) => this.toResponse(contact)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Da de alta un contacto en el directorio de la cuenta activa, creando el directorio si falta.
   *
   * El correo se normaliza y es único por directorio. Si ya existe un contacto vigente con ese
   * correo, responde 409. Si existe pero está archivado, lo **reactiva** con los datos nuevos en
   * lugar de rechazarlo: la restricción única también cubre a los archivados, así que de otro
   * modo un correo archivado no podría volver a darse de alta nunca. La autoría
   * (`createdByAccountId`/`updatedByAccountId`) es la membresía autorizada, nunca un dato del
   * cliente.
   *
   * @param authorization - Contexto autorizado de la petición.
   * @param activeAccountId - Valor del header `X-Account-Id`.
   * @param dto - Datos del contacto.
   * @returns El contacto creado o reactivado.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si `X-Account-Id` no es la cuenta que se autorizó.
   * @throws {ConflictException} (409) Si ya hay un contacto vigente con ese correo, también
   *   cuando otra petición lo dio de alta al mismo tiempo.
   *
   * @example
   * ```ts
   * const contact = await directoryService.createContact(authorization, 'acc-1', {
   *   firstName: 'Ana',
   *   lastName: 'García',
   *   email: 'Ana@Example.com',
   * });
   * contact.email; // 'ana@example.com'
   * ```
   */
  async createContact(
    authorization: AuthorizationContext,
    activeAccountId: string | undefined,
    dto: CreateDirectoryContactDto,
  ): Promise<DirectoryContactResponse> {
    const directory = await this.findOrCreateDirectory(
      this.resolveOwner(authorization, activeAccountId),
    );
    const emailNormalized = normalizeContactEmail(dto.email);
    const fields = {
      firstName: dto.firstName,
      lastName: dto.lastName,
      taxId: normalizeContactTaxId(dto.taxId) ?? null,
      phone: dto.phone ?? null,
    };

    const existing = await this.contactRepository.findOne({
      where: { directoryId: directory.id, emailNormalized },
    });

    if (existing && !existing.archivedAt) {
      throw new ConflictException(DUPLICATE_EMAIL_MESSAGE);
    }

    const contact = existing
      ? this.contactRepository.merge(existing, {
          ...fields,
          archivedAt: null,
          updatedByAccountId: authorization.accountId,
        })
      : this.contactRepository.create({
          ...fields,
          directoryId: directory.id,
          emailNormalized,
          createdByAccountId: authorization.accountId,
          updatedByAccountId: authorization.accountId,
        });

    return this.toResponse(await this.saveContact(contact));
  }

  /**
   * Actualiza un contacto vigente del directorio de la cuenta activa.
   *
   * Sólo cambia lo que llega en el cuerpo. Si cambia el correo, se normaliza y se comprueba que
   * no lo use otro contacto del directorio, vigente o archivado (los dos ocupan la restricción
   * única). Registra la membresía autorizada como `updatedByAccountId`.
   *
   * @param authorization - Contexto autorizado de la petición.
   * @param activeAccountId - Valor del header `X-Account-Id`.
   * @param contactId - Contacto a actualizar.
   * @param dto - Campos a cambiar.
   * @returns El contacto actualizado.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si `X-Account-Id` no es la cuenta que se autorizó.
   * @throws {NotFoundException} (404) Si el contacto no existe, es de otro directorio o está
   *   archivado.
   * @throws {ConflictException} (409) Si el correo nuevo ya lo usa otro contacto del directorio.
   *
   * @example
   * ```ts
   * await directoryService.updateContact(authorization, 'acc-1', 'contact-1', {
   *   phone: '+526141234567',
   * });
   * ```
   */
  async updateContact(
    authorization: AuthorizationContext,
    activeAccountId: string | undefined,
    contactId: string,
    dto: UpdateDirectoryContactDto,
  ): Promise<DirectoryContactResponse> {
    const contact = await this.findActiveContact(
      this.resolveOwner(authorization, activeAccountId),
      contactId,
    );

    if (dto.email !== undefined) {
      const emailNormalized = normalizeContactEmail(dto.email);
      if (emailNormalized !== contact.emailNormalized) {
        const taken = await this.contactRepository.exists({
          where: { directoryId: contact.directoryId, emailNormalized },
        });
        if (taken) {
          throw new ConflictException(DUPLICATE_EMAIL_MESSAGE);
        }
        contact.emailNormalized = emailNormalized;
      }
    }

    if (dto.firstName !== undefined) contact.firstName = dto.firstName;
    if (dto.lastName !== undefined) contact.lastName = dto.lastName;
    if (dto.taxId !== undefined) {
      contact.taxId = normalizeContactTaxId(dto.taxId) ?? null;
    }
    if (dto.phone !== undefined) contact.phone = dto.phone;
    contact.updatedByAccountId = authorization.accountId;

    return this.toResponse(await this.saveContact(contact));
  }

  /**
   * Archiva un contacto vigente del directorio de la cuenta activa (borrado lógico).
   *
   * Fija `archivedAt` y `updatedByAccountId`; la fila se conserva. Archivar dos veces responde
   * 404, porque un contacto archivado ya no es visible.
   *
   * @param authorization - Contexto autorizado de la petición.
   * @param activeAccountId - Valor del header `X-Account-Id`.
   * @param contactId - Contacto a archivar.
   * @returns El contacto ya archivado.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si `X-Account-Id` no es la cuenta que se autorizó.
   * @throws {NotFoundException} (404) Si el contacto no existe, es de otro directorio o ya está
   *   archivado.
   *
   * @example
   * ```ts
   * const archived = await directoryService.archiveContact(authorization, 'acc-1', 'contact-1');
   * archived.archivedAt; // Date
   * ```
   */
  async archiveContact(
    authorization: AuthorizationContext,
    activeAccountId: string | undefined,
    contactId: string,
  ): Promise<DirectoryContactResponse> {
    const contact = await this.findActiveContact(
      this.resolveOwner(authorization, activeAccountId),
      contactId,
    );

    contact.archivedAt = new Date();
    contact.updatedByAccountId = authorization.accountId;

    return this.toResponse(await this.contactRepository.save(contact));
  }

  /**
   * Resuelve el dueño del directorio a partir de la membresía autorizada.
   *
   * `X-Account-Id` es obligatorio y tiene que ser la misma membresía que autorizó
   * `PermissionsGuard`. El guard da prioridad a `X-Organization-Id` cuando llega, así que sin esta
   * comprobación un cliente podría autorizarse con una organización y nombrar otra cuenta en
   * `X-Account-Id`; aquí se exige que las dos digan lo mismo.
   *
   * @param authorization - Contexto autorizado de la petición.
   * @param activeAccountId - Valor del header `X-Account-Id`.
   * @returns La cuenta personal o la organización dueña del directorio.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si `X-Account-Id` no es la membresía autorizada.
   *
   * @example
   * ```ts
   * this.resolveOwner(personalAuthorization, 'acc-1');
   * // { personalAccountId: 'acc-1', organizationId: null }
   * ```
   */
  private resolveOwner(
    authorization: AuthorizationContext,
    activeAccountId: string | undefined,
  ): DirectoryOwner {
    if (!activeAccountId) {
      throw new BadRequestException(
        'Falta el header X-Account-Id de la cuenta activa',
      );
    }
    if (activeAccountId !== authorization.accountId) {
      throw new ForbiddenException(
        'X-Account-Id no corresponde a la cuenta autorizada',
      );
    }

    return authorization.organizationId
      ? {
          personalAccountId: null,
          organizationId: authorization.organizationId,
        }
      : { personalAccountId: authorization.accountId, organizationId: null };
  }

  /**
   * Busca el directorio de un dueño, sin crearlo.
   *
   * @param owner - Cuenta personal u organización.
   * @returns El directorio, o `null` si todavía no existe.
   *
   * @example
   * ```ts
   * const directory = await this.findDirectory({ personalAccountId: 'acc-1', organizationId: null });
   * ```
   */
  private findDirectory(
    owner: DirectoryOwner,
  ): Promise<DirectoryEntity | null> {
    return this.directoryRepository.findOne({
      where: owner.organizationId
        ? { organizationId: owner.organizationId }
        : { personalAccountId: owner.personalAccountId! },
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
   * const directory = await this.findOrCreateDirectory({ personalAccountId: null, organizationId: 'org-1' });
   * ```
   */
  private async findOrCreateDirectory(
    owner: DirectoryOwner,
  ): Promise<DirectoryEntity> {
    await this.directoryRepository
      .createQueryBuilder()
      .insert()
      .into(DirectoryEntity)
      .values(owner)
      .orIgnore()
      .execute();

    return this.directoryRepository.findOneOrFail({
      where: owner.organizationId
        ? { organizationId: owner.organizationId }
        : { personalAccountId: owner.personalAccountId! },
    });
  }

  /**
   * Busca un contacto vigente DENTRO del directorio del dueño.
   *
   * Lo ajeno, lo inexistente y lo archivado responden lo mismo: decir "existe, pero no es tuyo"
   * confirmaría a otra cuenta que ese contacto existe.
   *
   * @param owner - Cuenta personal u organización.
   * @param contactId - Contacto buscado.
   * @returns El contacto vigente.
   *
   * @throws {NotFoundException} (404) Si no hay directorio, o el contacto no existe en él, o está
   *   archivado.
   *
   * @example
   * ```ts
   * const contact = await this.findActiveContact(owner, 'contact-1');
   * ```
   */
  private async findActiveContact(
    owner: DirectoryOwner,
    contactId: string,
  ): Promise<DirectoryContactEntity> {
    const directory = await this.findDirectory(owner);
    const contact = directory
      ? await this.contactRepository.findOne({
          where: {
            id: contactId,
            directoryId: directory.id,
            archivedAt: IsNull(),
          },
        })
      : null;

    if (!contact) {
      throw new NotFoundException(CONTACT_NOT_FOUND_MESSAGE);
    }

    return contact;
  }

  /**
   * Guarda un contacto y traduce a 409 el choque con la unicidad del correo.
   *
   * La comprobación previa cubre el caso normal; esto cubre la carrera de dos altas simultáneas
   * del mismo correo, en la que las dos pasan la comprobación y sólo una puede insertar.
   *
   * @param contact - Contacto a guardar.
   * @returns El contacto guardado.
   *
   * @throws {ConflictException} (409) Si la base rechaza el correo por duplicado.
   * @throws {QueryFailedError} Cualquier otro error de la base, sin traducir.
   *
   * @example
   * ```ts
   * const saved = await this.saveContact(contact);
   * ```
   */
  private async saveContact(
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
        throw new ConflictException(DUPLICATE_EMAIL_MESSAGE);
      }
      throw error;
    }
  }

  /**
   * Traduce la entidad a la forma pública, con el correo normalizado como `email`.
   *
   * @param contact - Contacto guardado.
   * @returns El contacto como lo publica la API.
   *
   * @example
   * ```ts
   * this.toResponse(contact).email; // 'ana@example.com'
   * ```
   */
  private toResponse(
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
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { IsNull, Not, QueryFailedError, Repository } from 'typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { ACCOUNT_TYPE_ENUM } from 'src/account/enums/account-type.enum';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { UserEntity } from 'src/user/entities/user.entity';

import { DirectoryEntity } from './entities/directory.entity';
import { DirectoryContactEntity } from './entities/directory-contact.entity';
import { CreateDirectoryContactDto } from './dto/create-directory-contact.dto';
import { UpdateDirectoryContactDto } from './dto/update-directory-contact.dto';
import {
  DEFAULT_CONTACT_SEARCH_LIMIT,
  SearchDirectoryContactsDto,
} from './dto/search-directory-contacts.dto';
import { DirectoryContactResponse } from './interfaces/response/directory-contact-response';

const UNIQUE_VIOLATION = '23505';

/** Restricción de la migración `CreateDirectories`: un correo por directorio. */
const UNIQUE_EMAIL_CONSTRAINT = 'UQ_directory_contacts_directory_email';

const DUPLICATE_EMAIL_MESSAGE =
  'Ya existe un contacto con ese correo en el directorio';

const CONTACT_NOT_FOUND_MESSAGE = 'Contacto no encontrado';

/**
 * Dueño de un directorio: exactamente una de las dos columnas, igual que
 * `CHK_directories_single_owner`.
 */
type DirectoryOwner =
  | { personalAccountId: string; organizationId: null }
  | { personalAccountId: null; organizationId: string };

/** La cuenta activa validada y el directorio que le corresponde. */
interface DirectoryScope {
  /** Membresía que actúa: queda como autora del alta o del cambio. */
  accountId: string;
  owner: DirectoryOwner;
}

/**
 * Normaliza el correo de un contacto: es la forma en la que se guarda y con la que se compara.
 *
 * @param email - Correo tal como llegó.
 * @returns El correo sin espacios en los extremos y en minúsculas.
 *
 * @throws Nada.
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
 * Escapa los comodines de `LIKE` (`%`, `_` y `\`) para buscar el texto tal cual.
 *
 * Sin esto, buscar `a_b` encontraría también `axb@…`, y un `%` suelto devolvería el directorio
 * entero.
 *
 * @param term - Texto de búsqueda.
 * @returns El texto con los comodines escapados con `\`.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * escapeLikePattern('ana_g%'); // 'ana\\_g\\%'
 * ```
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Alta, edición, detalle y búsqueda por correo de los contactos del Directorio de la cuenta activa.
 *
 * El directorio nunca viaja en la petición: se deduce de la cuenta activa (`X-Account-Id`), que
 * se valida contra el usuario autenticado. Una cuenta **PERSONAL** usa el directorio de su
 * `accounts.id`; una de **ORGANIZATION**, el de su `organizationId`, compartido por todos los
 * miembros activos.
 *
 * Todo lo que no sea del directorio en contexto —un contacto de otra cuenta, uno que no existe o
 * uno archivado— responde igual, 404, para no confirmar qué existe en otros directorios.
 */
@Injectable()
export class DirectoryContactsService {
  constructor(
    @InjectRepository(DirectoryEntity)
    private readonly directoryRepository: Repository<DirectoryEntity>,
    @InjectRepository(DirectoryContactEntity)
    private readonly contactRepository: Repository<DirectoryContactEntity>,
    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  /**
   * Da de alta un contacto en el directorio de la cuenta activa, creando el directorio si falta.
   *
   * Normaliza el correo (`trim().toLowerCase()`). Si pertenece a un usuario de la plataforma, el
   * contacto queda vinculado a su cuenta PERSONAL; si no, se guarda sin vínculo. Un correo que ya
   * tiene un contacto vigente en el directorio responde 409; uno archivado se reactiva con los
   * datos nuevos, porque la unicidad del correo incluye a los archivados.
   *
   * @param userId - Usuario autenticado (`JwtPayload.sub`).
   * @param activeAccountId - Valor del header `X-Account-Id`.
   * @param dto - Nombre, apellido y correo.
   * @returns El contacto creado (o reactivado).
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si la cuenta activa no es del usuario o está dada de baja.
   * @throws {ConflictException} (409) Si ya hay un contacto vigente con ese correo en el
   *   directorio, también en la carrera de dos altas simultáneas.
   *
   * @example
   * ```ts
   * const { data } = await service.createContact('user-1', 'acc-1', {
   *   firstName: 'Ana',
   *   lastName: 'García',
   *   email: 'Ana@Example.com',
   * });
   * data.email; // 'ana@example.com'
   * ```
   */
  async createContact(
    userId: string,
    activeAccountId: string | undefined,
    dto: CreateDirectoryContactDto,
  ): Promise<BaseResponse<DirectoryContactResponse>> {
    const scope = await this.resolveScope(userId, activeAccountId);
    const directory = await this.findOrCreateDirectory(scope.owner);
    const emailNormalized = normalizeContactEmail(dto.email);

    const existing = await this.contactRepository.findOne({
      where: { directoryId: directory.id, emailNormalized },
    });
    if (existing && !existing.archivedAt) {
      throw new ConflictException(DUPLICATE_EMAIL_MESSAGE);
    }

    const contact =
      existing ??
      this.contactRepository.create({
        directoryId: directory.id,
        emailNormalized,
        createdByAccountId: scope.accountId,
      });
    contact.firstName = dto.firstName;
    contact.lastName = dto.lastName;
    this.applyLink(
      contact,
      await this.resolveLinkedPersonalAccount(emailNormalized),
    );
    contact.updatedByAccountId = scope.accountId;
    contact.archivedAt = null;

    const saved = await this.saveContact(contact);

    return {
      success: true,
      message: 'Contacto creado correctamente',
      data: this.toResponse(saved),
    };
  }

  /**
   * Actualiza nombre, apellido o correo de un contacto vigente del directorio de la cuenta activa.
   *
   * Sólo cambia lo enviado. Si cambia el correo, lo normaliza, comprueba que esté libre en el
   * directorio y vuelve a resolver el vínculo con la plataforma (se fija o se quita según el
   * correo nuevo). El contacto no puede cambiar de directorio: `directoryId` no se toca y el cuerpo
   * no acepta ningún identificador de cuenta u organización.
   *
   * @param userId - Usuario autenticado (`JwtPayload.sub`).
   * @param activeAccountId - Valor del header `X-Account-Id`.
   * @param contactId - Contacto a actualizar.
   * @param dto - Campos a cambiar.
   * @returns El contacto actualizado.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si la cuenta activa no es del usuario o está dada de baja.
   * @throws {NotFoundException} (404) Si el contacto no existe, es de otro directorio o está
   *   archivado.
   * @throws {ConflictException} (409) Si el correo nuevo ya lo usa otro contacto del directorio.
   *
   * @example
   * ```ts
   * await service.updateContact('user-1', 'acc-1', 'contact-1', { lastName: 'García Soto' });
   * ```
   */
  async updateContact(
    userId: string,
    activeAccountId: string | undefined,
    contactId: string,
    dto: UpdateDirectoryContactDto,
  ): Promise<BaseResponse<DirectoryContactResponse>> {
    const scope = await this.resolveScope(userId, activeAccountId);
    const contact = await this.findActiveContact(scope.owner, contactId);

    if (dto.email !== undefined) {
      const emailNormalized = normalizeContactEmail(dto.email);
      if (emailNormalized !== contact.emailNormalized) {
        const taken = await this.contactRepository.exists({
          where: {
            directoryId: contact.directoryId,
            emailNormalized,
            id: Not(contact.id),
          },
        });
        if (taken) {
          throw new ConflictException(DUPLICATE_EMAIL_MESSAGE);
        }
        contact.emailNormalized = emailNormalized;
        this.applyLink(
          contact,
          await this.resolveLinkedPersonalAccount(emailNormalized),
        );
      }
    }
    if (dto.firstName !== undefined) contact.firstName = dto.firstName;
    if (dto.lastName !== undefined) contact.lastName = dto.lastName;
    contact.updatedByAccountId = scope.accountId;

    const saved = await this.saveContact(contact);

    return {
      success: true,
      message: 'Contacto actualizado correctamente',
      data: this.toResponse(saved),
    };
  }

  /**
   * Devuelve el detalle de un contacto vigente del directorio de la cuenta activa.
   *
   * @param userId - Usuario autenticado (`JwtPayload.sub`).
   * @param activeAccountId - Valor del header `X-Account-Id`.
   * @param contactId - Contacto buscado.
   * @returns El contacto.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si la cuenta activa no es del usuario o está dada de baja.
   * @throws {NotFoundException} (404) Si el contacto no existe, es de otro directorio o está
   *   archivado.
   *
   * @example
   * ```ts
   * const { data } = await service.getContact('user-1', 'acc-1', 'contact-1');
   * ```
   */
  async getContact(
    userId: string,
    activeAccountId: string | undefined,
    contactId: string,
  ): Promise<BaseResponse<DirectoryContactResponse>> {
    const scope = await this.resolveScope(userId, activeAccountId);
    const contact = await this.findActiveContact(scope.owner, contactId);

    return {
      success: true,
      message: 'Contacto obtenido correctamente',
      data: this.toResponse(contact),
    };
  }

  /**
   * Busca, por fragmento del correo, los contactos vigentes del directorio de la cuenta activa.
   *
   * La coincidencia es parcial y no distingue mayúsculas: el fragmento se pasa a minúsculas y se
   * compara con `LIKE '%…%'` contra el correo normalizado, con sus comodines escapados. Nunca sale
   * del directorio en contexto. Ordena por apellido, nombre e id para que el resultado sea estable.
   *
   * @param userId - Usuario autenticado (`JwtPayload.sub`).
   * @param activeAccountId - Valor del header `X-Account-Id`.
   * @param query - Fragmento del correo y tope de resultados.
   * @returns Los contactos que coinciden, hasta `limit` (25 por omisión); vacío si la cuenta
   *   todavía no tiene directorio.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si la cuenta activa no es del usuario o está dada de baja.
   *
   * @example
   * ```ts
   * const { data } = await service.searchContacts('user-1', 'acc-1', { email: 'GARCIA' });
   * // contactos cuyo correo contiene "garcia"
   * ```
   */
  async searchContacts(
    userId: string,
    activeAccountId: string | undefined,
    query: SearchDirectoryContactsDto,
  ): Promise<BaseResponse<DirectoryContactResponse[]>> {
    const scope = await this.resolveScope(userId, activeAccountId);
    const directory = await this.findDirectory(scope.owner);

    const contacts = directory
      ? await this.contactRepository
          .createQueryBuilder('contact')
          .leftJoinAndSelect(
            'contact.linkedPersonalAccount',
            'linkedPersonalAccount',
          )
          .where('contact.directoryId = :directoryId', {
            directoryId: directory.id,
          })
          .andWhere('contact.archivedAt IS NULL')
          .andWhere("contact.emailNormalized LIKE :pattern ESCAPE '\\'", {
            pattern: `%${escapeLikePattern(normalizeContactEmail(query.email))}%`,
          })
          .orderBy('contact.lastName', 'ASC')
          .addOrderBy('contact.firstName', 'ASC')
          .addOrderBy('contact.id', 'ASC')
          .take(query.limit ?? DEFAULT_CONTACT_SEARCH_LIMIT)
          .getMany()
      : [];

    return {
      success: true,
      message: 'Contactos obtenidos correctamente',
      data: contacts.map((contact) => this.toResponse(contact)),
    };
  }

  /**
   * Valida la cuenta activa contra el usuario autenticado y deduce el dueño de su directorio.
   *
   * La pertenencia se comprueba en el propio `where` (cuenta + usuario + activa): una cuenta ajena,
   * una inexistente y una dada de baja responden el mismo 403. Un `X-Account-Id` que no es UUID
   * también, sin llegar a la base, donde rompería la consulta.
   *
   * @param userId - Usuario autenticado.
   * @param activeAccountId - Valor del header `X-Account-Id`.
   * @returns La membresía que actúa y el dueño del directorio.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si la cuenta no es del usuario, no existe o está dada de
   *   baja.
   *
   * @example
   * ```ts
   * const { owner } = await this.resolveScope('user-1', 'acc-1');
   * ```
   */
  private async resolveScope(
    userId: string,
    activeAccountId: string | undefined,
  ): Promise<DirectoryScope> {
    if (!activeAccountId) {
      throw new BadRequestException(
        'Falta el header X-Account-Id de la cuenta activa',
      );
    }

    const membership = isUUID(activeAccountId)
      ? await this.accountRepository.findOne({
          where: { id: activeAccountId, userId, isActive: true },
        })
      : null;

    if (!membership) {
      throw new ForbiddenException('No tienes acceso a esta cuenta');
    }

    if (membership.accountType === ACCOUNT_TYPE_ENUM.ORGANIZATION) {
      if (!membership.organizationId) {
        throw new ForbiddenException('No tienes acceso a esta cuenta');
      }
      return {
        accountId: membership.id,
        owner: {
          personalAccountId: null,
          organizationId: membership.organizationId,
        },
      };
    }

    return {
      accountId: membership.id,
      owner: { personalAccountId: membership.id, organizationId: null },
    };
  }

  /**
   * Busca el directorio de un dueño, sin crearlo.
   *
   * @param owner - Cuenta personal u organización.
   * @returns El directorio, o `null` si todavía no existe.
   *
   * @throws Nada más allá de los errores de la base.
   *
   * @example
   * ```ts
   * const directory = await this.findDirectory({ personalAccountId: 'acc-1', organizationId: null });
   * ```
   */
  private findDirectory(
    owner: DirectoryOwner,
  ): Promise<DirectoryEntity | null> {
    return this.directoryRepository.findOne({ where: this.ownerWhere(owner) });
  }

  /**
   * Devuelve el directorio de un dueño, creándolo si falta, sin carreras.
   *
   * Inserta con `ON CONFLICT DO NOTHING` y después lee: si dos miembros de la misma organización
   * dan de alta su primer contacto a la vez, uno inserta, el otro choca sin error con
   * `UQ_directories_organization_id`, y los dos leen la misma fila.
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
      where: this.ownerWhere(owner),
    });
  }

  /**
   * Filtro de `directories` para un dueño.
   *
   * @param owner - Cuenta personal u organización.
   * @returns El `where` por la columna que corresponde.
   *
   * @throws Nada.
   *
   * @example
   * ```ts
   * this.ownerWhere({ personalAccountId: null, organizationId: 'org-1' }); // { organizationId: 'org-1' }
   * ```
   */
  private ownerWhere(
    owner: DirectoryOwner,
  ): { organizationId: string } | { personalAccountId: string } {
    return owner.organizationId
      ? { organizationId: owner.organizationId }
      : { personalAccountId: owner.personalAccountId! };
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
          // Para publicar `linkedUserId`: el contacto guarda la cuenta, no el usuario.
          relations: { linkedPersonalAccount: true },
        })
      : null;

    if (!contact) {
      throw new NotFoundException(CONTACT_NOT_FOUND_MESSAGE);
    }

    return contact;
  }

  /**
   * Cuenta PERSONAL del usuario de la plataforma que tiene ese correo, para vincular el contacto.
   *
   * El vínculo es opcional: si el correo no es de ningún usuario vigente (o el usuario no tiene
   * cuenta personal), el contacto queda como externo. Se compara con `LOWER(email)` para no
   * depender de que todas las altas de usuario hayan guardado el correo en minúsculas. Los
   * usuarios borrados (`is_deleted`) no se vinculan.
   *
   * @param emailNormalized - Correo ya normalizado.
   * @returns Su cuenta PERSONAL (`id` y `userId`), o `null` si no corresponde a nadie.
   *
   * @throws Nada más allá de los errores de la base.
   *
   * @example
   * ```ts
   * await this.resolveLinkedPersonalAccount('ana@example.com');
   * // { id: 'acc-personal-ana', userId: 'user-ana' } | null
   * ```
   */
  private async resolveLinkedPersonalAccount(
    emailNormalized: string,
  ): Promise<Pick<AccountEntity, 'id' | 'userId'> | null> {
    const user = await this.userRepository
      .createQueryBuilder('user')
      .select(['user.id'])
      .where('LOWER(user.email) = :email', { email: emailNormalized })
      .andWhere('user.isDeleted = false')
      .getOne();
    if (!user) return null;

    const personalAccount = await this.accountRepository.findOne({
      where: { userId: user.id, accountType: ACCOUNT_TYPE_ENUM.PERSONAL },
      select: { id: true, userId: true },
    });

    return personalAccount
      ? { id: personalAccount.id, userId: personalAccount.userId }
      : null;
  }

  /**
   * Fija (o quita) el vínculo del contacto con una cuenta PERSONAL de la plataforma.
   *
   * Asigna la columna y también la relación, para que la respuesta publique `linkedUserId` sin
   * volver a leer el contacto.
   *
   * @param contact - Contacto a modificar (en memoria; no lo guarda).
   * @param link - Cuenta PERSONAL vinculada, o `null` si el contacto es externo.
   * @returns Nada.
   *
   * @throws Nada.
   *
   * @example
   * ```ts
   * this.applyLink(contact, { id: 'acc-personal-ana', userId: 'user-ana' });
   * ```
   */
  private applyLink(
    contact: DirectoryContactEntity,
    link: Pick<AccountEntity, 'id' | 'userId'> | null,
  ): void {
    contact.linkedPersonalAccountId = link?.id ?? null;
    contact.linkedPersonalAccount = link as AccountEntity | null;
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
   * @throws Nada.
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
      linkedPersonalAccountId: contact.linkedPersonalAccountId ?? null,
      linkedUserId: contact.linkedPersonalAccount?.userId ?? null,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
    };
  }
}

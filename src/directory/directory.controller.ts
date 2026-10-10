import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ActiveAccountId } from 'src/auth/decorators/active-account-id.decorator';
import { CurrentAuthorization } from 'src/authorization/decorators/current-authorization.decorator';
import { RequirePermission } from 'src/authorization/decorators/require-permission.decorator';
import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

// Casos de uso
import { ArchiveDirectoryContactUseCase } from './applications/archive-directory-contact.use-case';
import { CreateDirectoryContactUseCase } from './applications/create-directory-contact.use-case';
import { ListDirectoryContactsUseCase } from './applications/list-directory-contacts.use-case';
import { UpdateDirectoryContactUseCase } from './applications/update-directory-contact.use-case';

// DTOs
import { CreateDirectoryContactDto } from './dto/create-directory-contact.dto';
import { DirectoryContactParamsDto } from './dto/directory-contact-params.dto';
import { ListDirectoryContactsDto } from './dto/list-directory-contacts.dto';
import { UpdateDirectoryContactDto } from './dto/update-directory-contact.dto';

import {
  ApiArchiveDirectoryContact,
  ApiCreateDirectoryContact,
  ApiListDirectoryContacts,
  ApiUpdateDirectoryContact,
} from './docs/api-directory-contacts.docs';
import {
  DirectoryContactListResponse,
  DirectoryContactResponse,
} from './interfaces/response/directory-contact-response';

/** Valores por omisión de la paginación; los mismos que declara `ListDirectoryContactsDto`. */
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 25;

/**
 * Contactos del directorio de la cuenta activa.
 *
 * El controller no decide nada: `PermissionsGuard` comprueba la membresía y el permiso
 * `DIRECTORY.*` (una cuenta personal lo tiene siempre sobre lo suyo; una de organización, según su
 * rol), y cada endpoint traduce lo que recibió (DTOs validados, header y contexto autorizado) a
 * la solicitud tipada de su caso de uso. Ningún endpoint recibe el directorio como parámetro.
 */
@ApiTags('Directory')
@ApiBearerAuth('access-token')
@Controller('directory/contacts')
export class DirectoryController {
  constructor(
    private readonly listDirectoryContacts: ListDirectoryContactsUseCase,
    private readonly createDirectoryContact: CreateDirectoryContactUseCase,
    private readonly updateDirectoryContact: UpdateDirectoryContactUseCase,
    private readonly archiveDirectoryContact: ArchiveDirectoryContactUseCase,
  ) {}

  /**
   * Lista los contactos vigentes del directorio activo.
   *
   * @param authorization - Contexto autorizado por `PermissionsGuard`.
   * @param accountId - Header `X-Account-Id`.
   * @param query - Búsqueda y paginación.
   * @returns La página de contactos.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id` o la query es inválida.
   * @throws {ForbiddenException} (403) Sin membresía activa, sin `DIRECTORY.READ` o con
   *   `X-Account-Id` distinto de la cuenta autorizada.
   *
   * @example
   * ```ts
   * // GET /api/v1/directory/contacts?search=garcia&page=1&limit=25
   * ```
   */
  @Get()
  @ApiListDirectoryContacts()
  @RequirePermission(RESOURCE_KEY_ENUM.DIRECTORY, ACTION_KEY_ENUM.READ)
  listContacts(
    @CurrentAuthorization() authorization: AuthorizationContext,
    @ActiveAccountId() accountId: string | undefined,
    @Query() query: ListDirectoryContactsDto,
  ): Promise<DirectoryContactListResponse> {
    return this.listDirectoryContacts.execute({
      actor: { authorization, activeAccountId: accountId },
      search: query.search || undefined,
      page: query.page ?? DEFAULT_PAGE,
      limit: query.limit ?? DEFAULT_LIMIT,
    });
  }

  /**
   * Da de alta un contacto en el directorio activo.
   *
   * @param authorization - Contexto autorizado por `PermissionsGuard`.
   * @param accountId - Header `X-Account-Id`.
   * @param dto - Datos del contacto.
   * @returns El contacto creado (o reactivado, si su correo estaba archivado).
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id` o el cuerpo es inválido.
   * @throws {ForbiddenException} (403) Sin membresía activa, sin `DIRECTORY.CREATE` o con
   *   `X-Account-Id` distinto de la cuenta autorizada.
   * @throws {ConflictException} (409) Si ya hay un contacto vigente con ese correo.
   *
   * @example
   * ```ts
   * // POST /api/v1/directory/contacts { "firstName": "Ana", "lastName": "García", "email": "ana@example.com" }
   * ```
   */
  @Post()
  @ApiCreateDirectoryContact()
  @RequirePermission(RESOURCE_KEY_ENUM.DIRECTORY, ACTION_KEY_ENUM.CREATE)
  createContact(
    @CurrentAuthorization() authorization: AuthorizationContext,
    @ActiveAccountId() accountId: string | undefined,
    @Body() dto: CreateDirectoryContactDto,
  ): Promise<DirectoryContactResponse> {
    return this.createDirectoryContact.execute({
      actor: { authorization, activeAccountId: accountId },
      contact: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        taxId: dto.taxId,
        phone: dto.phone,
      },
    });
  }

  /**
   * Actualiza un contacto del directorio activo.
   *
   * @param authorization - Contexto autorizado por `PermissionsGuard`.
   * @param accountId - Header `X-Account-Id`.
   * @param params - Ruta, con el `contactId` a actualizar.
   * @param dto - Campos a cambiar.
   * @returns El contacto actualizado.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`, `contactId` no es UUID o el
   *   cuerpo es inválido.
   * @throws {ForbiddenException} (403) Sin membresía activa, sin `DIRECTORY.UPDATE` o con
   *   `X-Account-Id` distinto de la cuenta autorizada.
   * @throws {NotFoundException} (404) Si el contacto no está vigente en el directorio activo.
   * @throws {ConflictException} (409) Si el correo nuevo ya está en uso en el directorio.
   *
   * @example
   * ```ts
   * // PATCH /api/v1/directory/contacts/3f1c… { "phone": "+526141234567" }
   * ```
   */
  @Patch(':contactId')
  @ApiUpdateDirectoryContact()
  @RequirePermission(RESOURCE_KEY_ENUM.DIRECTORY, ACTION_KEY_ENUM.UPDATE)
  updateContact(
    @CurrentAuthorization() authorization: AuthorizationContext,
    @ActiveAccountId() accountId: string | undefined,
    @Param() params: DirectoryContactParamsDto,
    @Body() dto: UpdateDirectoryContactDto,
  ): Promise<DirectoryContactResponse> {
    return this.updateDirectoryContact.execute({
      actor: { authorization, activeAccountId: accountId },
      contactId: params.contactId,
      changes: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        taxId: dto.taxId,
        phone: dto.phone,
      },
    });
  }

  /**
   * Archiva un contacto del directorio activo; no lo borra.
   *
   * @param authorization - Contexto autorizado por `PermissionsGuard`.
   * @param accountId - Header `X-Account-Id`.
   * @param params - Ruta, con el `contactId` a archivar.
   * @returns El contacto archivado, con `archivedAt`.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id` o `contactId` no es UUID.
   * @throws {ForbiddenException} (403) Sin membresía activa, sin `DIRECTORY.DELETE` o con
   *   `X-Account-Id` distinto de la cuenta autorizada.
   * @throws {NotFoundException} (404) Si el contacto no está vigente en el directorio activo.
   *
   * @example
   * ```ts
   * // DELETE /api/v1/directory/contacts/3f1c…
   * ```
   */
  @Delete(':contactId')
  @ApiArchiveDirectoryContact()
  @RequirePermission(RESOURCE_KEY_ENUM.DIRECTORY, ACTION_KEY_ENUM.DELETE)
  archiveContact(
    @CurrentAuthorization() authorization: AuthorizationContext,
    @ActiveAccountId() accountId: string | undefined,
    @Param() params: DirectoryContactParamsDto,
  ): Promise<DirectoryContactResponse> {
    return this.archiveDirectoryContact.execute({
      actor: { authorization, activeAccountId: accountId },
      contactId: params.contactId,
    });
  }
}

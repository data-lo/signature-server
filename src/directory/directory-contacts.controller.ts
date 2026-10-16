import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ActiveAccountId } from 'src/auth/decorators/active-account-id.decorator';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import type { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { DirectoryContactsService } from './directory-contacts.service';
import { CreateDirectoryContactDto } from './dto/create-directory-contact.dto';
import { SearchDirectoryContactsDto } from './dto/search-directory-contacts.dto';
import { UpdateDirectoryContactDto } from './dto/update-directory-contact.dto';
import {
  ApiCreateDirectoryContact,
  ApiGetDirectoryContact,
  ApiSearchDirectoryContacts,
  ApiUpdateDirectoryContact,
} from './docs/api-directory-contacts-endpoints.docs';
import { DirectoryContactResponse } from './interfaces/response/directory-contact-response';

/**
 * Contactos del Directorio de la cuenta activa.
 *
 * El JWT lo exige el guard global de `AuthModule`. El controller no decide nada más:
 * `DirectoryContactsService` valida `X-Account-Id` contra el usuario autenticado y deduce de ahí el
 * directorio. Ningún endpoint recibe el directorio, la cuenta ni la organización como parámetro.
 */
@ApiTags('Directory')
@ApiBearerAuth('access-token')
@Controller('directory-contacts')
export class DirectoryContactsController {
  constructor(
    private readonly directoryContactsService: DirectoryContactsService,
  ) {}

  /**
   * Da de alta un contacto en el directorio activo.
   *
   * @param user - Usuario autenticado.
   * @param accountId - Header `X-Account-Id`.
   * @param dto - Nombre, apellido y correo.
   * @returns El contacto creado.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id` o el cuerpo es inválido.
   * @throws {ForbiddenException} (403) Si la cuenta activa no es del usuario.
   * @throws {ConflictException} (409) Si el correo ya está en el directorio.
   *
   * @example
   * ```ts
   * // POST /api/v1/directory-contacts { "firstName": "Ana", "lastName": "García", "email": "ana@example.com" }
   * ```
   */
  @Post()
  @ApiCreateDirectoryContact()
  createContact(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string | undefined,
    @Body() dto: CreateDirectoryContactDto,
  ): Promise<BaseResponse<DirectoryContactResponse>> {
    return this.directoryContactsService.createContact(
      user.sub,
      accountId,
      dto,
    );
  }

  /**
   * Busca contactos del directorio activo por fragmento del correo.
   *
   * @param user - Usuario autenticado.
   * @param accountId - Header `X-Account-Id`.
   * @param query - `email` (fragmento) y `limit` opcional.
   * @returns Los contactos que coinciden.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id` o `email`.
   * @throws {ForbiddenException} (403) Si la cuenta activa no es del usuario.
   *
   * @example
   * ```ts
   * // GET /api/v1/directory-contacts?email=garcia
   * ```
   */
  @Get()
  @ApiSearchDirectoryContacts()
  searchContacts(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string | undefined,
    @Query() query: SearchDirectoryContactsDto,
  ): Promise<BaseResponse<DirectoryContactResponse[]>> {
    return this.directoryContactsService.searchContacts(
      user.sub,
      accountId,
      query,
    );
  }

  /**
   * Devuelve un contacto del directorio activo.
   *
   * @param user - Usuario autenticado.
   * @param accountId - Header `X-Account-Id`.
   * @param id - Contacto buscado.
   * @returns El contacto.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id` o `id` no es UUID.
   * @throws {ForbiddenException} (403) Si la cuenta activa no es del usuario.
   * @throws {NotFoundException} (404) Si el contacto no está en el directorio activo.
   *
   * @example
   * ```ts
   * // GET /api/v1/directory-contacts/6a1f2c4e-8d3b-4f7a-9c2e-1b5d7e9f0a3c
   * ```
   */
  @Get(':id')
  @ApiGetDirectoryContact()
  getContact(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BaseResponse<DirectoryContactResponse>> {
    return this.directoryContactsService.getContact(user.sub, accountId, id);
  }

  /**
   * Actualiza nombre, apellido, correo, RFC o teléfono de un contacto del directorio activo.
   *
   * @param user - Usuario autenticado.
   * @param accountId - Header `X-Account-Id`.
   * @param id - Contacto a actualizar.
   * @param dto - Campos a cambiar.
   * @returns El contacto actualizado.
   *
   * @throws {BadRequestException} (400) Si falta `X-Account-Id`, `id` no es UUID o el cuerpo es
   *   inválido.
   * @throws {ForbiddenException} (403) Si la cuenta activa no es del usuario.
   * @throws {NotFoundException} (404) Si el contacto no está en el directorio activo.
   * @throws {ConflictException} (409) Si el correo nuevo ya está en el directorio.
   *
   * @example
   * ```ts
   * // PATCH /api/v1/directory-contacts/6a1f2c4e-… { "lastName": "García Soto" }
   * ```
   */
  @Patch(':id')
  @ApiUpdateDirectoryContact()
  updateContact(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDirectoryContactDto,
  ): Promise<BaseResponse<DirectoryContactResponse>> {
    return this.directoryContactsService.updateContact(
      user.sub,
      accountId,
      id,
      dto,
    );
  }
}

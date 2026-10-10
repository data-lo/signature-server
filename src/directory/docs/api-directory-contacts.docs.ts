import { applyDecorators } from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';

import {
  BadRequestResponse,
  ConflictResponse,
  ForbiddenResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';
import {
  DirectoryContactListResponse,
  DirectoryContactResponse,
} from '../interfaces/response/directory-contact-response';

/**
 * Lo que comparten los cuatro endpoints: la cuenta activa en `X-Account-Id`, el 401 del JWT, el
 * 400 por header ausente y el 403 de autorización.
 *
 * @param permission - Permiso que exige el endpoint a una cuenta de organización.
 * @returns Los decoradores comunes.
 *
 * @example
 * ```ts
 * applyDecorators(...commonDirectoryDocs('DIRECTORY.READ'));
 * ```
 */
function commonDirectoryDocs(permission: string) {
  return [
    ApiHeader({
      name: 'X-Account-Id',
      description:
        'UUID de la cuenta activa. Decide el directorio: el de la cuenta personal o el de su organización. El usuario debe ser miembro activo.',
      required: true,
    }),
    ApiResponse({
      status: 400,
      description: 'Datos inválidos o falta X-Account-Id',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description: `Sin membresía activa en la cuenta, X-Account-Id distinto de la cuenta autorizada, o (en una organización) el rol no tiene ${permission}`,
      type: ForbiddenResponse,
    }),
  ];
}

const CONTACT_ID_PARAM = ApiParam({
  name: 'contactId',
  format: 'uuid',
  description: 'Contacto del directorio de la cuenta activa',
});

/** `GET /directory/contacts` — contactos vigentes del directorio activo, paginados. */
export function ApiListDirectoryContacts() {
  return applyDecorators(
    ApiOperation({
      summary: 'Listar contactos del directorio',
      description:
        'Contactos vigentes (sin archivar) del directorio de la cuenta activa. `search` busca por nombre, apellido, nombre completo, correo o RFC. Una cuenta sin directorio responde la lista vacía. En una organización exige DIRECTORY.READ.',
    }),
    ApiResponse({
      status: 200,
      description: 'Página de contactos',
      type: DirectoryContactListResponse,
    }),
    ...commonDirectoryDocs('DIRECTORY.READ'),
  );
}

/** `POST /directory/contacts` — alta de un contacto en el directorio activo. */
export function ApiCreateDirectoryContact() {
  return applyDecorators(
    ApiOperation({
      summary: 'Crear contacto en el directorio',
      description:
        'Crea el contacto en el directorio de la cuenta activa (y el directorio, si es el primero). El correo se normaliza y es único por directorio. Un correo que pertenecía a un contacto archivado lo reactiva con los datos nuevos. El cuerpo no acepta directoryId, organizationId ni la autoría: se descartan. En una organización exige DIRECTORY.CREATE.',
    }),
    ApiResponse({
      status: 201,
      description: 'Contacto creado o reactivado',
      type: DirectoryContactResponse,
    }),
    ApiResponse({
      status: 409,
      description:
        'Ya existe un contacto vigente con ese correo en el directorio',
      type: ConflictResponse,
    }),
    ...commonDirectoryDocs('DIRECTORY.CREATE'),
  );
}

/** `PATCH /directory/contacts/:contactId` — edición de un contacto del directorio activo. */
export function ApiUpdateDirectoryContact() {
  return applyDecorators(
    ApiOperation({
      summary: 'Actualizar contacto del directorio',
      description:
        'Cambia sólo los campos enviados. Si cambia el correo, se normaliza y debe seguir siendo único en el directorio. En una organización exige DIRECTORY.UPDATE.',
    }),
    CONTACT_ID_PARAM,
    ApiResponse({
      status: 200,
      description: 'Contacto actualizado',
      type: DirectoryContactResponse,
    }),
    ApiResponse({
      status: 404,
      description:
        'El contacto no existe en el directorio de la cuenta activa, o está archivado',
      type: NotFoundResponse,
    }),
    ApiResponse({
      status: 409,
      description: 'El correo nuevo ya lo usa otro contacto del directorio',
      type: ConflictResponse,
    }),
    ...commonDirectoryDocs('DIRECTORY.UPDATE'),
  );
}

/** `DELETE /directory/contacts/:contactId` — archivado (borrado lógico) de un contacto. */
export function ApiArchiveDirectoryContact() {
  return applyDecorators(
    ApiOperation({
      summary: 'Archivar contacto del directorio',
      description:
        'Fija `archivedAt`: el contacto deja de aparecer en el listado, pero no se borra. En una organización exige DIRECTORY.DELETE.',
    }),
    CONTACT_ID_PARAM,
    ApiResponse({
      status: 200,
      description: 'Contacto archivado',
      type: DirectoryContactResponse,
    }),
    ApiResponse({
      status: 404,
      description:
        'El contacto no existe en el directorio de la cuenta activa, o ya está archivado',
      type: NotFoundResponse,
    }),
    ...commonDirectoryDocs('DIRECTORY.DELETE'),
  );
}

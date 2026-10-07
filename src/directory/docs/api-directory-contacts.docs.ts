import { applyDecorators } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';

import { NotFoundResponse } from 'src/interfaces/api-response.dto';
import { DirectoryContactResponse } from '../interfaces/response/directory-contact-response';

/** Header y respuestas que comparten los cuatro endpoints. */
function directoryContactsCommon() {
  return applyDecorators(
    ApiExtraModels(DirectoryContactResponse),
    ApiHeader({
      name: 'X-Account-Id',
      required: true,
      description:
        'Cuenta activa (personal o membresía de organización) del usuario autenticado. Define el directorio.',
    }),
    ApiResponse({
      status: 400,
      description: 'Falta X-Account-Id o la petición no es válida',
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description:
        'La cuenta activa no es del usuario autenticado o está dada de baja',
    }),
  );
}

/** Esquema `{ success, message, data }` con `data` de un tipo concreto. */
function wrapped(data: Record<string, unknown>) {
  return {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data,
    },
  };
}

const CONTACT_ID_PARAM = ApiParam({
  name: 'id',
  description: 'Identificador del contacto (UUID)',
  format: 'uuid',
});

const CONTACT_NOT_FOUND = ApiResponse({
  status: 404,
  description: 'El contacto no existe, es de otro directorio o está archivado',
  type: NotFoundResponse,
});

/** `POST /directory-contacts` — alta de un contacto. */
export function ApiCreateDirectoryContact() {
  return applyDecorators(
    directoryContactsCommon(),
    ApiOperation({
      summary: 'Crear un contacto del directorio',
      description:
        'Lo da de alta en el directorio de la cuenta activa (personal u organización). Si el correo es de un usuario de la plataforma, lo vincula a su cuenta personal.',
    }),
    ApiResponse({
      status: 201,
      description: 'Contacto creado',
      schema: wrapped({ $ref: getSchemaPath(DirectoryContactResponse) }),
    }),
    ApiResponse({
      status: 409,
      description: 'Ya existe un contacto con ese correo en el directorio',
    }),
  );
}

/** `PATCH /directory-contacts/:id` — edición de nombre, apellido o correo. */
export function ApiUpdateDirectoryContact() {
  return applyDecorators(
    directoryContactsCommon(),
    ApiOperation({
      summary: 'Actualizar un contacto del directorio',
      description:
        'Cambia sólo los campos enviados. El contacto no puede pasar a otro directorio.',
    }),
    CONTACT_ID_PARAM,
    ApiResponse({
      status: 200,
      description: 'Contacto actualizado',
      schema: wrapped({ $ref: getSchemaPath(DirectoryContactResponse) }),
    }),
    CONTACT_NOT_FOUND,
    ApiResponse({
      status: 409,
      description: 'El correo nuevo ya lo usa otro contacto del directorio',
    }),
  );
}

/** `GET /directory-contacts/:id` — detalle de un contacto. */
export function ApiGetDirectoryContact() {
  return applyDecorators(
    directoryContactsCommon(),
    ApiOperation({ summary: 'Obtener un contacto del directorio' }),
    CONTACT_ID_PARAM,
    ApiResponse({
      status: 200,
      description: 'Contacto encontrado',
      schema: wrapped({ $ref: getSchemaPath(DirectoryContactResponse) }),
    }),
    CONTACT_NOT_FOUND,
  );
}

/** `GET /directory-contacts?email=` — búsqueda por correo. */
export function ApiSearchDirectoryContacts() {
  return applyDecorators(
    directoryContactsCommon(),
    ApiOperation({
      summary: 'Buscar contactos del directorio por correo',
      description:
        'Coincidencia parcial y sin distinguir mayúsculas, sólo dentro del directorio de la cuenta activa.',
    }),
    ApiResponse({
      status: 200,
      description: 'Contactos que coinciden (puede ser una lista vacía)',
      schema: wrapped({
        type: 'array',
        items: { $ref: getSchemaPath(DirectoryContactResponse) },
      }),
    }),
  );
}

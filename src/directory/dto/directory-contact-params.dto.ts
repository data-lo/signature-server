import { IsUUID } from 'class-validator';

/**
 * Parámetros de ruta de `PATCH` y `DELETE /directory/contacts/:contactId`.
 *
 * El `ValidationPipe` global responde 400 si `contactId` no es un UUID, antes de llegar al caso
 * de uso. Swagger lo documenta con `ApiParam` en `docs/api-directory-contacts.docs.ts`.
 */
export class DirectoryContactParamsDto {
  @IsUUID('all', { message: 'contactId debe ser un UUID' })
  contactId: string;
}

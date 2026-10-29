import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import {
  MAX_CONTACT_EMAIL_LENGTH,
  MAX_CONTACT_NAME_LENGTH,
  MAX_CONTACT_PHONE_LENGTH,
  MAX_CONTACT_TAX_ID_LENGTH,
  trimString,
  trimToNull,
} from './create-directory-contact.dto';

/**
 * Cuerpo de `PATCH /directory/contacts/:contactId`: sólo lo que se quiere cambiar.
 *
 * No es `PartialType(CreateDirectoryContactDto)` porque los campos obligatorios no pueden
 * borrarse: con `@IsOptional`, un `"firstName": null` saltaría la validación y llegaría a una
 * columna `NOT NULL`. Aquí se omiten (`undefined`) o se mandan con valor; `null` es un error de
 * validación. `taxId` y `phone`, en cambio, sí admiten `null` para vaciarlos.
 *
 * Igual que en el alta, cualquier propiedad que no esté aquí (`directoryId`, `organizationId`,
 * autoría) la descarta el `ValidationPipe` global.
 */
export class UpdateDirectoryContactDto {
  @ApiPropertyOptional({ example: 'Ana', maxLength: MAX_CONTACT_NAME_LENGTH })
  @Transform(trimString)
  @ValidateIf((dto: UpdateDirectoryContactDto) => dto.firstName !== undefined)
  @IsString()
  @IsNotEmpty({ message: 'El nombre no puede quedar vacío' })
  @MaxLength(MAX_CONTACT_NAME_LENGTH)
  firstName?: string;

  @ApiPropertyOptional({
    example: 'García',
    maxLength: MAX_CONTACT_NAME_LENGTH,
  })
  @Transform(trimString)
  @ValidateIf((dto: UpdateDirectoryContactDto) => dto.lastName !== undefined)
  @IsString()
  @IsNotEmpty({ message: 'El apellido no puede quedar vacío' })
  @MaxLength(MAX_CONTACT_NAME_LENGTH)
  lastName?: string;

  @ApiPropertyOptional({
    example: 'ana.garcia@example.com',
    description:
      'Se normaliza (`trim().toLowerCase()`) y debe seguir siendo único en el directorio.',
    maxLength: MAX_CONTACT_EMAIL_LENGTH,
  })
  @Transform(trimString)
  @ValidateIf((dto: UpdateDirectoryContactDto) => dto.email !== undefined)
  @IsEmail({}, { message: 'El correo no es válido' })
  @MaxLength(MAX_CONTACT_EMAIL_LENGTH)
  email?: string;

  @ApiPropertyOptional({
    example: 'GAAA900101XXX',
    description: 'RFC del contacto. `null` lo vacía.',
    maxLength: MAX_CONTACT_TAX_ID_LENGTH,
    nullable: true,
  })
  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CONTACT_TAX_ID_LENGTH)
  taxId?: string | null;

  @ApiPropertyOptional({
    example: '+526141234567',
    description: '`null` lo vacía.',
    maxLength: MAX_CONTACT_PHONE_LENGTH,
    nullable: true,
  })
  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CONTACT_PHONE_LENGTH)
  phone?: string | null;
}

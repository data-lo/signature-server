import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import {
  MAX_CONTACT_EMAIL_LENGTH,
  MAX_CONTACT_NAME_LENGTH,
  trimString,
} from './create-directory-contact.dto';

/**
 * Cuerpo de `PATCH /directory-contacts/:id`: los mismos tres campos que el alta, todos opcionales.
 *
 * Sólo cambia lo que viene. `ValidateIf(value !== undefined)` hace que un `null` explícito se
 * valide —y se rechace— en vez de saltarse como "no vino": los tres campos son obligatorios en la
 * entidad. Igual que en el alta, no hay forma de mover el contacto a otro directorio: ni
 * `accountId`, ni `organizationId`, ni `directoryId` existen aquí.
 */
export class UpdateDirectoryContactDto {
  @ApiPropertyOptional({ example: 'Ana', maxLength: MAX_CONTACT_NAME_LENGTH })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'El nombre no puede quedar vacío' })
  @MaxLength(MAX_CONTACT_NAME_LENGTH)
  firstName?: string;

  @ApiPropertyOptional({
    example: 'García López',
    maxLength: MAX_CONTACT_NAME_LENGTH,
  })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'El apellido no puede quedar vacío' })
  @MaxLength(MAX_CONTACT_NAME_LENGTH)
  lastName?: string;

  @ApiPropertyOptional({
    example: 'ana.garcia@example.com',
    maxLength: MAX_CONTACT_EMAIL_LENGTH,
  })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trimString)
  @IsEmail({}, { message: 'El correo no es válido' })
  @MaxLength(MAX_CONTACT_EMAIL_LENGTH)
  email?: string;
}

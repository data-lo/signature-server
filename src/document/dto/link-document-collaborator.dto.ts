import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/**
 * Cuerpo opcional de `PATCH /document/:id/link-collaborator`.
 *
 * Con `collaboratorId` se vincula ESA invitación y la respuesta dice exactamente qué pasó
 * (`outcome`). Sin él se mantiene el comportamiento anterior: buscar una invitación pendiente del
 * documento con el correo de la cuenta. En ningún caso se acepta un correo del cliente: el que se
 * compara es el verificado de la cuenta autenticada.
 */
export class LinkDocumentCollaboratorDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Colaborador de la invitación (referencia del enlace del correo)',
  })
  @IsOptional()
  @IsUUID()
  collaboratorId?: string;
}

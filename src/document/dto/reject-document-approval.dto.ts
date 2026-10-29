import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Cuerpo de `POST /api/v1/documents/:documentId/approval/reject`.
 *
 * El comentario es opcional porque negar la autorización es una decisión válida por sí sola: un
 * reviewer que no quiere explicarse no debería quedarse sin poder rechazar. Cuando lo escribe, es
 * lo que el creador va a leer en el correo, así que se guarda tal cual —sin normalizar ni
 * recortar palabras— con un tope que evita que alguien use el campo como almacenamiento.
 */
export class RejectDocumentApprovalDto {
  @ApiPropertyOptional({
    example: 'Falta el anexo B firmado por el área legal.',
    maxLength: 1000,
    description:
      'Motivo del rechazo. Se guarda en el colaborador y se le envía al creador del documento.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  resolutionNote?: string;
}

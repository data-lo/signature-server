import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { DocumentService } from '../document.service';

/**
 * Engancha la cuenta del usuario autenticado a la invitación que había recibido sólo por correo
 * (`PATCH /document/:id/link-collaborator`).
 *
 * Existe como endpoint propio porque el frontend lo llama justo después de que alguien completa
 * registro o inicia sesión desde el enlace del correo, antes de redirigirlo al documento. La misma
 * vinculación ocurre de forma perezosa al firmar, pero adelantarla evita que la pantalla de detalle
 * cargue sin reconocer todavía al usuario como firmante.
 *
 * No encontrar nada que vincular no es un error: es el caso normal de cualquier documento ajeno a
 * este flujo, y por eso responde `linked: false` en vez de 404.
 */
@Injectable()
export class LinkDocumentCollaboratorUseCase {
  constructor(private readonly documentService: DocumentService) {}

  async execute(
    documentId: string,
    currentUserId: string,
  ): Promise<BaseResponse<{ linked: boolean }>> {
    return this.documentService.linkPendingCollaboratorAccount(
      documentId,
      currentUserId,
    );
  }
}

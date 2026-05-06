import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DocumentService } from './document.service';
import { DocumentSignEventPayload } from './interfaces/document-sign-event-payload';

@Injectable()
export class DocumentEventService {
    private readonly logger = new Logger(DocumentEventService.name);

    constructor(private readonly documentService: DocumentService) { }

    @OnEvent('document.sign', { async: true })
    async handleDocumentSign(payload: DocumentSignEventPayload) {
        this.logger.log(`[document.sign] Iniciando estampado de firma | documentId: ${payload.documentId} | signerId: ${payload.signerId}`);

        try {
            await this.documentService.mergeSignatureAndSave(payload);
            this.logger.log(`[document.sign] Firma estampada correctamente | documentId: ${payload.documentId}`);
        } catch (error) {
            this.logger.error(
                `[document.sign] error al estampar la firma | documentId: ${payload.documentId} | mensaje: ${error}`,
                error,
            );
        }
    }
}
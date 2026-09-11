import { Injectable } from '@nestjs/common';

import { DocumentService } from '../document.service';

@Injectable()
export class GetDocumentFileUrlUseCase {
  constructor(private readonly documentService: DocumentService) {}

  async execute(
    documentId: string,
    userId: string,
    { asAttachment = false }: { asAttachment?: boolean } = {},
  ) {
    await this.documentService.assertUserHasAccess(documentId, userId);

    return this.documentService.getDocumentMinioURL(documentId, {
      asAttachment,
    });
  }
}

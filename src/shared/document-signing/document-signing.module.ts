import { Module } from '@nestjs/common';
import { PdfSignatureService } from './document-signing.service';

@Module({
  providers: [PdfSignatureService],
  exports: [PdfSignatureService],
})
export class DocumentSigningModule {}

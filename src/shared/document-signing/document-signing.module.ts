import { Module } from '@nestjs/common';
import { PdfSignatureService } from './document-signing.service';

@Module({
  controllers: [],
  providers: [PdfSignatureService],
  exports: [PdfSignatureService],
})
export class DocumentSigningModule {}

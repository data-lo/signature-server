import { Module } from '@nestjs/common';
import { SummaryDocumentService } from './summary-document.service';

@Module({
  providers: [SummaryDocumentService],
  exports: [SummaryDocumentService],
})
export class SummaryDocumentModule {}

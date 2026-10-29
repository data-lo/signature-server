import { Module } from '@nestjs/common';
import { SummaryDocumentService } from './summary-document.service';
import { AdvancedSummaryDocumentService } from './advanced-summary-document.service';

/**
 * Una hoja de evidencia por tipo de firma: `SummaryDocumentService` para la firma simple y
 * `AdvancedSummaryDocumentService` para la avanzada (e.firma). Comparten la plomería de render
 * (`sheet-rendering.ts`), no el contenido.
 */
@Module({
  providers: [SummaryDocumentService, AdvancedSummaryDocumentService],
  exports: [SummaryDocumentService, AdvancedSummaryDocumentService],
})
export class SummaryDocumentModule {}

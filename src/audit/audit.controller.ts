import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuditQuery } from './audit.service';
import { GetDocumentAuditTrailUseCase } from './applications/get-document-audit-trail.use-case';
import { GetDecryptedAuditRecordsUseCase } from './applications/get-decrypted-audit-records.use-case';
import { GetAuditRecordsUseCase } from './applications/get-audit-records.use-case';
import { ApiGetDocumentAuditTrail } from './docs/api-get-document-audit-trail.docs';
import { ApiGetDecryptedAuditRecords } from './docs/api-get-decrypted-audit-records.docs';
import { ApiGetAuditRecords } from './docs/api-get-audit-records.docs';

@ApiTags('Audit')
@ApiBearerAuth('access-token')
@Controller('audit')
export class AuditController {
  constructor(
    private readonly getDocumentAuditTrail: GetDocumentAuditTrailUseCase,
    private readonly getDecryptedAuditRecords: GetDecryptedAuditRecordsUseCase,
    private readonly getAuditRecords: GetAuditRecordsUseCase,
  ) {}

  @Get('document/:documentId')
  @ApiGetDocumentAuditTrail()
  findByDocument(@Param('documentId') documentId: string) {
    return this.getDocumentAuditTrail.execute(documentId);
  }

  @Get('decrypted')
  @ApiGetDecryptedAuditRecords()
  findAllDecrypted(@Query() query: AuditQuery) {
    return this.getDecryptedAuditRecords.execute(query);
  }

  @Get()
  @ApiGetAuditRecords()
  findAll(@Query() query: AuditQuery) {
    return this.getAuditRecords.execute(query);
  }
}

import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import type { AuditQuery } from './audit.service';
import { ApiGetDocumentAuditTrail } from './docs/api-get-document-audit-trail.docs';
import { ApiGetDecryptedAuditRecords } from './docs/api-get-decrypted-audit-records.docs';
import { ApiGetAuditRecords } from './docs/api-get-audit-records.docs';

@ApiTags('Audit')
@ApiBearerAuth('access-token')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('document/:documentId')
  @ApiGetDocumentAuditTrail()
  findByDocument(@Param('documentId') documentId: string) {
    return this.auditService.findOne(documentId);
  }

  @Get('decrypted')
  @ApiGetDecryptedAuditRecords()
  findAllDecrypted(@Query() query: AuditQuery) {
    return this.auditService.findAllDecrypted(query);
  }

  @Get()
  @ApiGetAuditRecords()
  findAll(@Query() query: AuditQuery) {
    return this.auditService.findAll(query);
  }
}

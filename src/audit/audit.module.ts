import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { GetDocumentAuditTrailUseCase } from './applications/get-document-audit-trail.use-case';
import { GetDecryptedAuditRecordsUseCase } from './applications/get-decrypted-audit-records.use-case';
import { GetAuditRecordsUseCase } from './applications/get-audit-records.use-case';
import { AuditDocument, AuditSchema } from './schema/audit-document';
import { SharedModule } from 'src/shared/shared.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AuditDocument.name, schema: AuditSchema },
    ]),
    SharedModule,
  ],
  controllers: [AuditController],
  providers: [
    AuditService,
    GetDocumentAuditTrailUseCase,
    GetDecryptedAuditRecordsUseCase,
    GetAuditRecordsUseCase,
  ],
  exports: [AuditService],
})
export class AuditModule {}

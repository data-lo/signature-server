import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditDocument, AuditSchema } from './schema/audit-document';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AuditDocument.name, schema: AuditSchema }
    ])
  ],
  controllers: [AuditController],
  providers: [AuditService],
})
export class AuditModule {}

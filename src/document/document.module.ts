import { Module } from '@nestjs/common';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentEntity } from './entities/document.entity';
import { DocumentParticipantEntity } from './entities/document-participant.entity';
import { SharedModule } from 'src/shared/shared.module';
import { UserModule } from 'src/user/user.module';
import { SignatureModule } from 'src/signature/signature.module';
import { AuditModule } from 'src/audit/audit.module';

@Module({
  controllers: [DocumentController],
  providers: [DocumentService],
  imports: [
    TypeOrmModule.forFeature([DocumentEntity, DocumentParticipantEntity]),
    SharedModule,
    UserModule,
    SignatureModule,
    AuditModule,
  ],
  exports: [DocumentService],
})
export class DocumentModule {}

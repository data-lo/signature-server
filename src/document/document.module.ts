import { Module } from '@nestjs/common';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { DocumentSignaturesService } from './document-signatures.service';
import { DocumentSignaturesController } from './document-signatures.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentEntity } from './entities/document.entity';
import { CollaboratorEntity } from './entities/collaborator.entity';
import { VerificationCodeEntity } from './entities/verification-code.entity';
import { VerificationCodeService } from './verification-code.service';
import { SharedModule } from 'src/shared/shared.module';
import { UserModule } from 'src/user/user.module';
import { SignatureModule } from 'src/signature/signature.module';
import { AuditModule } from 'src/audit/audit.module';
import { KafkaModule } from 'src/kafka/kafka.module';
import { AccountModule } from 'src/account/account.module';
import { DocumentTransactionModule } from './document-transaction.module';
import { EfirmaModule } from 'src/efirma/efirma.module';

@Module({
  controllers: [DocumentController, DocumentSignaturesController],
  providers: [
    DocumentService,
    VerificationCodeService,
    DocumentSignaturesService,
  ],
  imports: [
    TypeOrmModule.forFeature([
      DocumentEntity,
      CollaboratorEntity,
      VerificationCodeEntity,
    ]),
    SharedModule,
    UserModule,
    SignatureModule,
    AuditModule,
    KafkaModule,
    AccountModule,
    DocumentTransactionModule,
    EfirmaModule,
  ],
  exports: [DocumentService],
})
export class DocumentModule {}

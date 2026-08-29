import { Module } from '@nestjs/common';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
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
import { SealModule } from './seal/seal.module';
import { SummaryDocumentModule } from './summary-document/summary-document.module';
import { SignatureQrService } from './services/signature-qr.service';

// Use cases
import { GetDocumentFileUrlUseCase } from './applications/get-document-file-url.use-case';
import { GetPublicDocumentUseCase } from './applications/get-public-document.use-case';
import { GetPublicSealArtifactUseCase } from './applications/get-public-seal-artifact.use-case';
import { GetPublicDocumentAuditXmlUseCase } from './applications/get-public-document-audit-xml.use-case';
import { GetPublicAdvancedSignatureUseCase } from './applications/get-public-advanced-signature.use-case';
import { CreateDocumentUseCase } from './applications/create-document.use-case';
import { GetDocumentsUseCase } from './applications/get-documents.use-case';
import { GetDocumentUseCase } from './applications/get-document.use-case';
import { SubmitDocumentForAuthorizationUseCase } from './applications/submit-document-for-authorization.use-case';
import { SignDocumentUseCase } from './applications/sign-document.use-case';
import { LinkDocumentCollaboratorUseCase } from './applications/link-document-collaborator.use-case';
import { RequestDocumentVerificationCodeUseCase } from './applications/request-document-verification-code.use-case';
import { VerifyDocumentCodeUseCase } from './applications/verify-document-code.use-case';
import { RejectDocumentUseCase } from './applications/reject-document.use-case';
import { SubmitDocumentForCancellationUseCase } from './applications/submit-document-for-cancellation.use-case';
import { ConfirmDocumentCancellationUseCase } from './applications/confirm-document-cancellation.use-case';
import { UpdateDocumentUseCase } from './applications/update-document.use-case';
import { DeleteDocumentUseCase } from './applications/delete-document.use-case';
import { CreateDocumentSignatureFlowUseCase } from './applications/create-document-signature-flow.use-case';

@Module({
  controllers: [DocumentController, DocumentSignaturesController],
  providers: [
    DocumentService,
    VerificationCodeService,
    SignatureQrService,
    GetDocumentFileUrlUseCase,
    GetPublicDocumentUseCase,
    GetPublicSealArtifactUseCase,
    GetPublicDocumentAuditXmlUseCase,
    GetPublicAdvancedSignatureUseCase,
    CreateDocumentUseCase,
    GetDocumentsUseCase,
    GetDocumentUseCase,
    SubmitDocumentForAuthorizationUseCase,
    SignDocumentUseCase,
    LinkDocumentCollaboratorUseCase,
    RequestDocumentVerificationCodeUseCase,
    VerifyDocumentCodeUseCase,
    RejectDocumentUseCase,
    SubmitDocumentForCancellationUseCase,
    ConfirmDocumentCancellationUseCase,
    UpdateDocumentUseCase,
    DeleteDocumentUseCase,
    CreateDocumentSignatureFlowUseCase,
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
    SealModule,
    SummaryDocumentModule,
  ],
  exports: [DocumentService],
})
export class DocumentModule {}

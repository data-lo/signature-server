import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SignatureService } from './signature.service';
import { SignatureCaptureSessionService } from './signature-capture-session.service';
import { SignatureController } from './signature.controller';
import { SignatureCaptureSessionsController } from './signature-capture-sessions.controller';
import { SignatureEntity } from './entities/signature.entity';
import { SignatureCaptureSessionEntity } from './entities/signature-capture-session.entity';
import { SimpleSignatureEntity } from './entities/simple-signature.entity';
import { FielSignatureEntity } from './entities/fiel-signature.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { MinioService } from 'src/shared/minio/minio.service';
import { SharedModule } from 'src/shared/shared.module';
import { IdentityVerificationModule } from 'src/identity-verification/identity-verification.module';
import { UploadSignatureImageUseCase } from './applications/upload-signature-image.use-case';
import { DeleteSignatureImageUseCase } from './applications/delete-signature-image.use-case';
import { CreateSignatureCaptureSessionUseCase } from './applications/create-signature-capture-session.use-case';
import { ClaimMobileSignatureSessionUseCase } from './applications/claim-mobile-signature-session.use-case';
import { SaveHandwrittenSignatureUseCase } from './applications/save-handwritten-signature.use-case';
import { GetSignatureCaptureSessionStatusUseCase } from './applications/get-signature-capture-session-status.use-case';
import { CancelSignatureCaptureSessionUseCase } from './applications/cancel-signature-capture-session.use-case';
import { GetSignatureFileUseCase } from './applications/get-signature-file.use-case';
import { GetSignatureUseCase } from './applications/get-signature.use-case';
import { UpdateSignatureUseCase } from './applications/update-signature.use-case';
import { DeactivateSignatureUseCase } from './applications/deactivate-signature.use-case';
import { DeleteOfficialFileUseCase } from './applications/delete-official-file.use-case';

/**
 * Dominio de la firma del usuario: el archivo vigente y los intentos de capturarlo.
 *
 * La captura por canvas y QR vive acá y no en un módulo aparte porque comparte lo esencial con
 * lo que ya había: `SaveHandwrittenSignatureUseCase` termina llamando al mismo
 * `UploadSignatureImageUseCase` que atiende `PUT /api/v1/users/me/signature`, de modo que hay un
 * solo camino hacia CONFIGURED sin importar por dónde entró la rúbrica.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SignatureEntity,
      SignatureCaptureSessionEntity,
      SimpleSignatureEntity,
      FielSignatureEntity,
      UserEntity,
    ]),
    SharedModule,
    IdentityVerificationModule,
  ],
  controllers: [SignatureController, SignatureCaptureSessionsController],
  providers: [
    SignatureService,
    SignatureCaptureSessionService,
    MinioService,
    UploadSignatureImageUseCase,
    DeleteSignatureImageUseCase,
    CreateSignatureCaptureSessionUseCase,
    ClaimMobileSignatureSessionUseCase,
    SaveHandwrittenSignatureUseCase,
    GetSignatureCaptureSessionStatusUseCase,
    CancelSignatureCaptureSessionUseCase,
    GetSignatureFileUseCase,
    GetSignatureUseCase,
    UpdateSignatureUseCase,
    DeactivateSignatureUseCase,
    DeleteOfficialFileUseCase,
  ],
  // `UploadSignatureImageUseCase` se exporta para `UsersController`, dueño de
  // `PUT /api/v1/users/me/signature`.
  exports: [SignatureService, UploadSignatureImageUseCase],
})
export class SignatureModule {}

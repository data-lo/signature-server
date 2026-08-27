import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SharedModule } from 'src/shared/shared.module';
import { DocumentEntity } from '../entities/document.entity';
import { VerificationCodeEntity } from '../entities/verification-code.entity';
import { SealController } from './seal.controller';
import { SealEntity } from './entities/seal.entity';
import { SealDocumentUseCase } from './use-cases/seal-document.use-case';
import { SendCompletedSimpleSignatureToSealUseCase } from './use-cases/send-completed-simple-signature-to-seal.use-case';
import { SealApiService } from './services/seal-api.service';

/**
 * Sellado de documentos contra Seal Service (sello de tiempo RFC 3161 + constancia NOM-151).
 *
 * Exporta `SealDocumentUseCase` porque el sellado ya no se dispara solo desde su controlador:
 * `DocumentService` lo invoca al completarse la firma avanzada de un documento (ver historia
 * "Completar flujo de firma avanzada e integración con Seal Service"). Exporta también
 * `SendCompletedSimpleSignatureToSealUseCase`, su equivalente para los documentos de firma
 * simple, que el mismo servicio invoca cuando firma el último firmante.
 *
 * La dependencia va en un solo sentido —DocumentModule → SealModule— así que no hay ciclo: de
 * `DocumentModule` acá sólo entran entidades (clases, no providers), registradas con
 * `forFeature` para consultarlas sin depender de sus servicios.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SealEntity,
      DocumentEntity,
      VerificationCodeEntity,
    ]),
    SharedModule,
  ],
  controllers: [SealController],
  providers: [
    SealDocumentUseCase,
    SendCompletedSimpleSignatureToSealUseCase,
    SealApiService,
  ],
  exports: [SealDocumentUseCase, SendCompletedSimpleSignatureToSealUseCase],
})
export class SealModule {}

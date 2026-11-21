import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EfirmaModule } from 'src/efirma/efirma.module';
import { SharedModule } from 'src/common/shared.module';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { VerificationCodeEntity } from '../entities/verification-code.entity';
import { SealController } from './seal.controller';
import { SealEntity } from './entities/seal.entity';
import { SealDocumentUseCase } from './use-cases/seal-document.use-case';
import { RetryPendingSealUseCase } from './use-cases/retry-pending-seal.use-case';
import { SendCompletedSimpleSignatureToSealUseCase } from './use-cases/send-completed-simple-signature-to-seal.use-case';
import { SealApiService } from './services/seal-api.service';
import { DocumentSealingJobEntity } from './entities/document-sealing-job.entity';
import { SealingRequestSnapshotService } from './services/sealing-request-snapshot.service';
import { RegisterDocumentSealingJobUseCase } from './use-cases/register-document-sealing-job.use-case';
import { ProcessDocumentSealingJobUseCase } from './use-cases/process-document-sealing-job.use-case';

/**
 * Sellado de documentos contra Seal Service (sello de tiempo RFC 3161 + constancia NOM-151).
 *
 * Exporta `SealDocumentUseCase` porque el sellado ya no se dispara solo desde su controlador:
 * `DocumentService` lo invoca al completarse la firma avanzada de un documento (ver historia
 * "Completar flujo de firma avanzada e integración con Seal Service"). Exporta también
 * `SendCompletedSimpleSignatureToSealUseCase`, su equivalente para los documentos de firma
 * simple, que el mismo servicio invoca cuando firma el último firmante.
 *
 * Exporta también lo que `DocumentService.finalizeSignedDocument` usa para dejar el sellado como
 * trabajo persistente (`document_sealing_jobs`) en vez de llamar al proveedor durante la firma:
 * `SealingRequestSnapshotService` congela el payload y `RegisterDocumentSealingJobUseCase` registra
 * el trabajo dentro de la transacción de cierre.
 *
 * `ProcessDocumentSealingJobUseCase` ejecuta un trabajo reclamado: OCSP, sello y PDF final. La
 * fase del PDF necesita la hoja de evidencia de `DocumentModule`; para no invertir la dependencia,
 * `DocumentModule` registra su implementación al arrancar (`RefreshSealedDocumentEvidenceService`).
 *
 * La dependencia va en un solo sentido —DocumentModule → SealModule— así que no hay ciclo: de
 * `DocumentModule` acá sólo entran entidades (clases, no providers), registradas con
 * `forFeature` para consultarlas sin depender de sus servicios.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SealEntity,
      DocumentSealingJobEntity,
      DocumentEntity,
      CollaboratorEntity,
      VerificationCodeEntity,
    ]),
    SharedModule,
    // La fase VERIFYING_OCSP vuelve a consultar el OCSP del SAT con el certificado que quedó
    // guardado en la firma (ver `RetryPendingSealUseCase`).
    EfirmaModule,
  ],
  controllers: [SealController],
  providers: [
    SealDocumentUseCase,
    SendCompletedSimpleSignatureToSealUseCase,
    RetryPendingSealUseCase,
    SealApiService,
    SealingRequestSnapshotService,
    RegisterDocumentSealingJobUseCase,
    ProcessDocumentSealingJobUseCase,
  ],
  exports: [
    SealDocumentUseCase,
    SendCompletedSimpleSignatureToSealUseCase,
    RetryPendingSealUseCase,
    SealingRequestSnapshotService,
    RegisterDocumentSealingJobUseCase,
    ProcessDocumentSealingJobUseCase,
  ],
})
export class SealModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SealController } from './seal.controller';
import { SealEntity } from './entities/seal.entity';
import { SealDocumentUseCase } from './use-cases/seal-document.use-case';
import { SealApiService } from './services/seal-api.service';

/**
 * Sellado de documentos contra Seal Service (sello de tiempo RFC 3161 + constancia NOM-151).
 *
 * Exporta `SealDocumentUseCase` porque el sellado ya no se dispara solo desde su controlador:
 * `DocumentService` lo invoca al completarse la firma avanzada de un documento (ver historia
 * "Completar flujo de firma avanzada e integración con Seal Service"). La dependencia va en un
 * solo sentido —DocumentModule → SealModule— así que no hay ciclo: este módulo solo referencia a
 * `DocumentEntity` como tipo, para la FK de `SealEntity`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SealEntity])],
  controllers: [SealController],
  providers: [SealDocumentUseCase, SealApiService],
  exports: [SealDocumentUseCase],
})
export class SealModule {}

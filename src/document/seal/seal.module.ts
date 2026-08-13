import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SealController } from './seal.controller';
import { SealEntity } from './entities/seal.entity';
import { SealDocumentUseCase } from './use-cases/seal-document.use-case';
import { HttpModule } from '@nestjs/axios';
import { SealApiService } from './services/seal-api.service';

@Module({
  imports: [TypeOrmModule.forFeature([SealEntity]), HttpModule],
  controllers: [SealController],
  providers: [SealDocumentUseCase, SealApiService],
})
export class SealModule {}

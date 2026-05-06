import { Module } from '@nestjs/common';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentEntity } from './entities/document.entity';

@Module({
  controllers: [DocumentController],
  providers: [DocumentService],
  imports: [TypeOrmModule.forFeature([DocumentEntity])],
  exports: [DocumentService]
})
export class DocumentModule { }

import { Module } from '@nestjs/common';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentEntity } from './entities/document.entity';
import { SharedModule } from 'src/shared/shared.module';
import { UserModule } from 'src/user/user.module';
import { SignatureModule } from 'src/signature/signature.module';
import { DocumentEventService } from './document.event.service';

@Module({
  controllers: [DocumentController],
  providers: [DocumentService, DocumentEventService],
  imports: [TypeOrmModule.forFeature([DocumentEntity]), SharedModule, UserModule, SignatureModule],
  exports: [DocumentService]
})
export class DocumentModule { }

// 1. NestJS (framework)
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
// 2. Internal modules
import { UserModule } from 'src/user/user.module';
import { SharedModule } from 'src/shared/shared.module';
import { DocumentModule } from 'src/document/document.module';
import { AuditModule } from 'src/audit/audit.module';
import { VerificationCodeService } from './verification-code.service';
import { VerificationCodeEntity } from './entities/verification-code.entity';
import { VerificationCodeController } from './verification-code.controller';
import { VerificationCodeEventService } from './verification-code.event.sevice';

@Module({
  imports: [
    TypeOrmModule.forFeature([VerificationCodeEntity]),
    UserModule,
    SharedModule,
    DocumentModule,
    AuditModule,
  ],
  exports: [VerificationCodeService],
  controllers: [VerificationCodeController],
  providers: [VerificationCodeService, VerificationCodeEventService],
})
export class VerificationCodeModule {}

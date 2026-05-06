// 1. NestJS (framework)
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
// 2. Internal modules
import { UserModule } from 'src/user/user.module';
import { SharedModule } from 'src/shared/shared.module';
import { DocumentModule } from 'src/document/document.module';
import { VerificationCodeService } from './verification-code.service';
import { VerificationCodeEntity } from './entities/verification-code.entity';
import { VerificationCodeController } from './verification-code.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([VerificationCodeEntity]),
    UserModule,
    SharedModule,
    DocumentModule,
  ],
  exports: [VerificationCodeService],
  providers: [VerificationCodeService],
  controllers: [VerificationCodeController],
})
export class VerificationCodeModule { }

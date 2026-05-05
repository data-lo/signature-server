// 1. NestJS (framework)
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
// 2. Internal modules
import { UserModule } from 'src/user/user.module';
import { OTPModule } from 'src/shared/otp/otp.module';
import { DocumentModule } from 'src/document/document.module';
import { RedisModule } from 'src/shared/redis/redis.module';
import { EmailModule } from 'src/email/email.module';

import { VerificationCodeService } from './verification-code.service';
import { VerificationCodeController } from './verification-code.controller';
import { VerificationCodeEntity } from './entities/verification-code.entity';
import { RedisService } from 'src/shared/redis/redis.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([VerificationCodeEntity]),
    OTPModule,
    RedisModule,
    UserModule,
    EmailModule,
    DocumentModule,
  ],
  controllers: [VerificationCodeController],
  providers: [VerificationCodeService, RedisService],
  exports: [VerificationCodeService],
})
export class VerificationCodeModule { }

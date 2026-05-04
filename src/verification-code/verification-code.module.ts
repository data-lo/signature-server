import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VerificationCodeService } from './verification-code.service';
import { VerificationCodeController } from './verification-code.controller';
import { VerificationCodeEntity } from './entities/verification-code.entity';
import { OtpModule } from '../shared/otp/otp.module';
import { RedisService } from 'src/shared/redis/redis.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([VerificationCodeEntity]),
    OtpModule,
  ],
  controllers: [VerificationCodeController],
  providers: [VerificationCodeService, RedisService],
  exports: [VerificationCodeService],
})
export class VerificationCodeModule {}

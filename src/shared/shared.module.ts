import { Module } from '@nestjs/common';

// Services
import { OTPService } from './otp/otp.service';
import { HashService } from './hash/hash.service';
import { EmailService } from './email/email.service';
import { MinioService } from './minio/minio.service';
import { RedisService } from './redis/redis.service';
import { DocumentSigningService } from './document-signing/document-signing.service';

const services = [
  DocumentSigningService,
  EmailService,
  HashService,
  MinioService,
  OTPService,
  RedisService,
];

@Module({
  providers: services,
  exports: services,
})
export class SharedModule {}
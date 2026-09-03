import { Module } from '@nestjs/common';

import { OTPService } from './otp/otp.service';
import { HashService } from './hash/hash.service';
import { EmailService } from './email/email.service';
import { MinioService } from './minio/minio.service';
import { RedisService } from './redis/redis.service';
import { PdfSignatureService } from './document-signing/document-signing.service';
import { PasswordService } from './password/password.service';
import { TurnstileService } from './turnstile/turnstile.service';

const services = [
  PdfSignatureService,
  EmailService,
  HashService,
  MinioService,
  OTPService,
  RedisService,
  PasswordService,
  TurnstileService,
];

@Module({
  providers: services,
  exports: services,
})
export class SharedModule {}

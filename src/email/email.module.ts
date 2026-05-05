import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from './email.service';


@Module({
  imports: [ConfigModule],
  exports: [EmailService],
  providers: [EmailService],
})
export class EmailModule {}
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SignatureModule } from './signature/signature.module';
import { UserModule } from './user/user.module';
import { DocumentModule } from './document/document.module';
import { EmailModule } from './email/email.module';
import { ConfigModule} from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IpInterceptor } from './ip/ip.interceptor';

@Module({
  imports: [SignatureModule, UserModule, DocumentModule, EmailModule,
    ConfigModule.forRoot({
      envFilePath: '.env',
      isGlobal: true,
    }),
  ],
  controllers: [AppController],
  providers: [AppService, {
    provide: APP_INTERCEPTOR,
    useClass: IpInterceptor,
  }],
})
export class AppModule {}

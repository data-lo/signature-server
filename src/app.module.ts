// Core NestJS
import { Module } from '@nestjs/common';

// Config & Database
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';

// App
import { AppService } from './app.service';
import { AppController } from './app.controller';

// Modules
import { UserModule } from './user/user.module';
import { AuditModule } from './audit/audit.module';
import { IpInterceptor } from './ip/ip.interceptor';
import { DocumentModule } from './document/document.module';
import { SignatureModule } from './signature/signature.module';
import { VerificationCodeModule } from './verification-code/verification-code.module';
import { SharedModule } from './shared/shared.module';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: 'default',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        url: config.get('POSTGRES_DB_URL'),
        type: 'postgres',
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),

    TypeOrmModule.forRootAsync({
      name: 'mongo',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        url: config.get('MONGO_DB_URL'),
        type: 'mongodb',
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),

    DocumentModule,
    UserModule,
    AuditModule,
    SignatureModule,
    VerificationCodeModule,
    SharedModule,
  ],
  controllers: [AppController],
  providers: [AppService, {
    provide: APP_INTERCEPTOR,
    useClass: IpInterceptor,
  }, SharedModule],
})
export class AppModule { }
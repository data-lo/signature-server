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
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { IpInterceptor } from './ip/ip.interceptor';
import { SharedModule } from './shared/shared.module';
import { DocumentModule } from './document/document.module';
import { SignatureModule } from './signature/signature.module';
import { VerificationCodeModule } from './verification-code/verification-code.module';
import { RedisModule } from './shared/redis/redis.module';
import { EventEmitterModule } from '@nestjs/event-emitter';

@Module({
  imports: [
    EventEmitterModule.forRoot({
      delimiter: '.'
    }),

    TypeOrmModule.forRootAsync({
      name: 'default',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        url: config.get('POSTGRES_DB_URL'),
        type: 'postgres',
        autoLoadEntities: true,
        synchronize: true,
      }),
    }),

    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get('MONGO_DB_URL'),
      }),
    }),

    ConfigModule.forRoot({
      isGlobal: true,
    }),
    AuthModule,
    DocumentModule,
    UserModule,
    AuditModule,
    SignatureModule,
    VerificationCodeModule,
    SharedModule,
    RedisModule,
  ],
  controllers: [AppController],
  providers: [AppService, {
    provide: APP_INTERCEPTOR,
    useClass: IpInterceptor,
  }, SharedModule],
})
export class AppModule { }
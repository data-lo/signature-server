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
import { AuthModule } from './auth/auth.module';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from './audit/audit.module';
import { ThrottlerModule } from '@nestjs/throttler';
import { IpInterceptor } from './ip/ip.interceptor';
import { SharedModule } from './shared/shared.module';
import { DocumentModule } from './document/document.module';
import { SignatureModule } from './signature/signature.module';
import { HealthModule } from './health/health.module';
import { AccountModule } from './account/account.module';
import { KafkaModule } from './kafka/kafka.module';


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

    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 60000,
          limit: 10,
        },
      ],
    }),

    ConfigModule.forRoot({
      isGlobal: true,
    }),
    AuthModule,
    DocumentModule,
    UserModule,
    AccountModule,
    AuditModule,
    SignatureModule,
    SharedModule,
    HealthModule,
    KafkaModule,
  ],
  controllers: [AppController],
  providers: [AppService, {
    provide: APP_INTERCEPTOR,
    useClass: IpInterceptor,
  }, SharedModule],
})
export class AppModule { }
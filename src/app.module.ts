// Core NestJS
import { Module } from '@nestjs/common';

// Config & Database
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';

// App
import { AppService } from './app.service';
import { AppController } from './app.controller';

// Modules

import { DocumentModule } from './document/document.module';
import { UserModule } from './user/user.module';
import { AuditModule } from './audit/audit.module';
import { SignatureModule } from './signature/signature.module';


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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
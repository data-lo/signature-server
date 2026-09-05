import { Module } from '@nestjs/common';
import { join } from 'path';

import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AppService } from './app.service';
import { AppController } from './app.controller';

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
import { EfirmaModule } from './efirma/efirma.module';

import { KafkaModule } from './kafka/kafka.module';
import { PaymentsModule } from './payments/payments.module';
import { RolesModule } from './roles/roles.module';
import { EventModule } from './event/event.module';
import { SealModule } from './document/seal/seal.module';
import { IdentityVerificationModule } from './identity-verification/identity-verification.module';
import { WebhooksModule } from './webhooks/webhooks.module';

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
        // El esquema lo gobiernan las migraciones de `src/migrations/`, no la sincronización
        // automática. Con `synchronize: true` TypeORM derivaba el esquema de las entidades en cada
        // arranque: las migraciones no se aplicaban nunca —llegaron a acumularse 21 pendientes, y
        // el enum de eventos se quedó sin `document.collaborator_signed` en las bases construidas
        // desde migraciones— y en un entorno con datos reales podía alterar tablas sin que nadie lo
        // pidiera.
        synchronize: false,
        // Glob de doble extensión porque `nest start` ejecuta `dist/` mientras que la CLI de TypeORM
        // corre sobre `src/`: `__dirname` apunta a la carpeta real en cada caso.
        migrations: [join(__dirname, 'migrations', '*{.ts,.js}')],
        migrationsRun: true,
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
          ttl: 60000, // Unidad: ms
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
    EfirmaModule,
    KafkaModule,
    PaymentsModule,
    RolesModule,
    EventModule,
    SealModule,
    IdentityVerificationModule,
    WebhooksModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: IpInterceptor,
    },
    SharedModule,
  ],
})
export class AppModule {}

// Core NestJS
import { Module } from '@nestjs/common';

// Config & Database
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';

// App
import { AppService } from './app.service';
import { AppController } from './app.controller';

// Modules
import { SignatureModule } from './signature/signature.module';
import { DocumentModule } from './document/document.module';
import { UserModule } from './user/user.module';


@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const databaseUrl = config.get<string>('DATABASE_URL');
        
        if (databaseUrl) {
          return {
            type: 'postgres',
            url: databaseUrl,
            autoLoadEntities: true,
            synchronize: false,
          } as const;
        }

        const host = config.get<string>('DB_HOST') || 'localhost';
        const port = parseInt(config.get<string>('DB_PORT') || '5432', 10);
        const username = config.get<string>('DB_USER') || 'postgres';
        const password = config.get<string>('DB_PASSWORD') || 'postgres';
        const database = config.get<string>('DB_NAME') || 'postgres';

        return {
          type: 'postgres',
          host,
          port,
          username,
          password,
          database,
          autoLoadEntities: true,
          synchronize: false,
        } as const;
      },
    }),

    SignatureModule,
    DocumentModule,
    UserModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
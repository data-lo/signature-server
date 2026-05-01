import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SignatureModule } from './signature/signature.module';
import { UsersModule } from './users/users.module';
import { DocumentModule } from './document/document.module';
import { SignatureModule } from './signature/signature.module';

@Module({
  imports: [SignatureModule, UsersModule, DocumentModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

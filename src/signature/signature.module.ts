import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SignatureService } from './signature.service';
import { SignatureController } from './signature.controller';
import { SignatureEntity } from './entities/signature.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { MinioService } from 'src/shared/minio/minio.service';
import { SharedModule } from 'src/shared/shared.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SignatureEntity, UserEntity]),
    SharedModule,
  ],
  controllers: [SignatureController],
  providers: [SignatureService, MinioService],
  exports: [SignatureService],
})
export class SignatureModule {}

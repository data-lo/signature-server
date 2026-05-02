import { Module } from '@nestjs/common';
import { SignatureService } from './signature.service';
import { SignatureController } from './signature.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SignatureEntity } from './entities/signature.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { MinioService } from 'src/shared/minio/minio.service';

@Module({
  controllers: [SignatureController],
  providers: [SignatureService, MinioService],
  imports: [TypeOrmModule.forFeature([SignatureEntity, UserEntity])],
})
export class SignatureModule { }

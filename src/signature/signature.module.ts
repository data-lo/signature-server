import { Module } from '@nestjs/common';
import { SignatureService } from './signature.service';
import { SignatureController } from './signature.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SignatureEntity } from './entities/signature.entity';
import { UserEntity } from 'src/user/entities/user.entity';

@Module({
  controllers: [SignatureController],
  providers: [SignatureService],
  imports: [TypeOrmModule.forFeature([SignatureEntity, UserEntity])],
})
export class SignatureModule { }

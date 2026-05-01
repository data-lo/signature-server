import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './entities/user.entity';

@Module({
  exports: [UserService],
  providers: [UserService],
  controllers: [UserController],
  imports: [TypeOrmModule.forFeature([UserEntity])],
})
export class UserModule { }

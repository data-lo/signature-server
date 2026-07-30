import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { UsersController } from './users.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './entities/user.entity';
import { PersonalInformationEntity } from './entities/personal-information.entity';
import { EmailVerificationCodeEntity } from './entities/email-verification-code.entity';
import { EmailVerificationCodeService } from './email-verification-code.service';
import { SignatureModule } from 'src/signature/signature.module';
import { SharedModule } from 'src/shared/shared.module';
import { AccountModule } from 'src/account/account.module';

@Module({
  exports: [UserService, EmailVerificationCodeService],
  providers: [UserService, EmailVerificationCodeService],
  controllers: [UserController, UsersController],
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      PersonalInformationEntity,
      EmailVerificationCodeEntity,
    ]),
    SignatureModule,
    SharedModule,
    AccountModule,
  ],
})
export class UserModule {}

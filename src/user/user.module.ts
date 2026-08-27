import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { CreateUserUseCase } from './applications/create-user.use-case';
import { ListUsersUseCase } from './applications/list-users.use-case';
import { GetUserUseCase } from './applications/get-user.use-case';
import { UpdateUserUseCase } from './applications/update-user.use-case';
import { DeleteUserUseCase } from './applications/delete-user.use-case';
import { CheckRfcAvailabilityUseCase } from './applications/check-rfc-availability.use-case';
import { GetMyProfileUseCase } from './applications/get-my-profile.use-case';
import { UpdateMyPersonalInformationUseCase } from './applications/update-my-personal-information.use-case';
import { CompleteMyOnboardingUseCase } from './applications/complete-my-onboarding.use-case';
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
  exports: [UserService, EmailVerificationCodeService, GetUserUseCase],
  providers: [
    UserService,
    EmailVerificationCodeService,
    CreateUserUseCase,
    ListUsersUseCase,
    GetUserUseCase,
    UpdateUserUseCase,
    DeleteUserUseCase,
    CheckRfcAvailabilityUseCase,
    GetMyProfileUseCase,
    UpdateMyPersonalInformationUseCase,
    CompleteMyOnboardingUseCase,
  ],
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

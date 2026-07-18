import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountService } from './account.service';
import { AccountController } from './account.controller';
import { OrganizationsController } from './organizations.controller';
import { AccountsController } from './accounts.controller';
import { AccountMemberService } from './account-member.service';
import { AccountMemberController } from './account-member.controller';
import { AccountEntity } from './entities/account.entity';
import { OrganizationEntity } from './entities/organization.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { SharedModule } from 'src/shared/shared.module';
import { RolesModule } from 'src/roles/roles.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AccountEntity, OrganizationEntity, UserEntity]),
    SharedModule,
    RolesModule,
  ],
  controllers: [
    AccountController,
    OrganizationsController,
    AccountsController,
    AccountMemberController,
  ],
  providers: [AccountService, AccountMemberService],
  exports: [AccountService, AccountMemberService],
})
export class AccountModule {}

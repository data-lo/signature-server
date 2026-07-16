import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountService } from './account.service';
import { AccountController } from './account.controller';
import { AccountMemberService } from './account-member.service';
import { AccountMemberController } from './account-member.controller';
import { AccountEntity } from './entities/account.entity';
import { OrganizationDetailEntity } from './entities/organization-detail.entity';
import { AccountMemberEntity } from './entities/account-member.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AccountEntity,
      OrganizationDetailEntity,
      AccountMemberEntity,
    ]),
  ],
  controllers: [AccountController, AccountMemberController],
  providers: [AccountService, AccountMemberService],
  exports: [AccountService, AccountMemberService],
})
export class AccountModule {}

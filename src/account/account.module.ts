import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountService } from './account.service';
import { AccountController } from './account.controller';
import { OrganizationsController } from './organizations.controller';
import { AccountsController } from './accounts.controller';
import { AccountMemberService } from './account-member.service';
import { AccountMemberController } from './account-member.controller';
import { OrganizationInvitationService } from './organization-invitation.service';
import { OrganizationInvitationsController } from './organization-invitation.controller';
import { AccountEntity } from './entities/account.entity';
import { OrganizationEntity } from './entities/organization.entity';
import { OrganizationInvitationEntity } from './entities/organization-invitation.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { SharedModule } from 'src/shared/shared.module';
import { RolesModule } from 'src/roles/roles.module';
import { KafkaModule } from 'src/kafka/kafka.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AccountEntity,
      OrganizationEntity,
      OrganizationInvitationEntity,
      UserEntity,
    ]),
    SharedModule,
    RolesModule,
    KafkaModule,
  ],
  controllers: [
    AccountController,
    OrganizationsController,
    AccountsController,
    AccountMemberController,
    OrganizationInvitationsController,
  ],
  providers: [AccountService, AccountMemberService, OrganizationInvitationService],
  exports: [AccountService, AccountMemberService, OrganizationInvitationService],
})
export class AccountModule {}

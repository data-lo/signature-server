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
import { OrganizationPermissionsModule } from 'src/organization-permissions/organization-permissions.module';

import { CreateAccountUseCase } from './applications/create-account.use-case';
import { ListAccountsUseCase } from './applications/list-accounts.use-case';
import { GetAccountUseCase } from './applications/get-account.use-case';
import { UpdateAccountUseCase } from './applications/update-account.use-case';
import { GetMyAccountsUseCase } from './applications/get-my-accounts.use-case';
import { CreateOrganizationUseCase } from './applications/create-organization.use-case';
import { InviteOrganizationMemberUseCase } from './applications/invite-organization-member.use-case';
import { GetOrganizationInvitationPreviewUseCase } from './applications/get-organization-invitation-preview.use-case';
import { AcceptOrganizationInvitationUseCase } from './applications/accept-organization-invitation.use-case';
import { GrantAccountAccessUseCase } from './applications/grant-account-access.use-case';
import { GetOrganizationMembersUseCase } from './applications/get-organization-members.use-case';
import { GetOrganizationMemberListUseCase } from './applications/get-organization-member-list.use-case';
import { GetAccountMemberUseCase } from './applications/get-account-member.use-case';
import { UpdateAccountMemberUseCase } from './applications/update-account-member.use-case';
import { RevokeAccountAccessUseCase } from './applications/revoke-account-access.use-case';

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
    OrganizationPermissionsModule,
  ],
  controllers: [
    AccountController,
    OrganizationsController,
    AccountsController,
    AccountMemberController,
    OrganizationInvitationsController,
  ],
  providers: [
    AccountService,
    AccountMemberService,
    OrganizationInvitationService,
    CreateAccountUseCase,
    ListAccountsUseCase,
    GetAccountUseCase,
    UpdateAccountUseCase,
    GetMyAccountsUseCase,
    CreateOrganizationUseCase,
    InviteOrganizationMemberUseCase,
    GetOrganizationInvitationPreviewUseCase,
    AcceptOrganizationInvitationUseCase,
    GrantAccountAccessUseCase,
    GetOrganizationMembersUseCase,
    GetOrganizationMemberListUseCase,
    GetAccountMemberUseCase,
    UpdateAccountMemberUseCase,
    RevokeAccountAccessUseCase,
  ],
  exports: [
    AccountService,
    AccountMemberService,
    OrganizationInvitationService,
  ],
})
export class AccountModule {}

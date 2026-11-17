import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccountModule } from 'src/account/account.module';
import { ApiKeyModule } from 'src/api-key/api-key.module';
import { BillingProvisioningModule } from 'src/billing/billing-provisioning.module';
import { BillingModule } from 'src/billing/billing.module';
import { RolesModule } from 'src/roles/roles.module';
import { UserModule } from 'src/user/user.module';

import { GrantOrganizationCreditsUseCase } from './applications/grant-organization-credits.use-case';
import { ProvisionProvisionalEnterpriseAccountUseCase } from './applications/provision-provisional-enterprise-account.use-case';
import { PlatformCreditGrantEntity } from './entities/platform-credit-grant.entity';
import { PlatformRequestEntity } from './entities/platform-request.entity';
import { InternalOrganizationCreditsController } from './internal-organization-credits.controller';
import { InternalOrganizationProvisioningController } from './internal-organization-provisioning.controller';
import { ProvisionalOwnerProvisioningService } from './services/provisional-owner-provisioning.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PlatformRequestEntity,
      PlatformCreditGrantEntity,
    ]),
    UserModule,
    AccountModule,
    RolesModule,
    BillingProvisioningModule,
    BillingModule,
    ApiKeyModule,
  ],
  controllers: [
    InternalOrganizationProvisioningController,
    InternalOrganizationCreditsController,
  ],
  providers: [
    ProvisionalOwnerProvisioningService,
    ProvisionProvisionalEnterpriseAccountUseCase,
    GrantOrganizationCreditsUseCase,
  ],
})
export class PlatformModule {}

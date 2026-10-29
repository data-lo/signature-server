import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccountModule } from 'src/account/account.module';
import { ApiKeyModule } from 'src/api-key/api-key.module';
import { BillingProvisioningModule } from 'src/billing/billing-provisioning.module';
import { BillingModule } from 'src/billing/billing.module';
import { RolesModule } from 'src/roles/roles.module';
import { UserModule } from 'src/user/user.module';

import { ProvisionProvisionalEnterpriseAccountUseCase } from './applications/provision-provisional-enterprise-account.use-case';
import { PlatformProvisioningRequestEntity } from './entities/platform-provisioning-request.entity';
import { InternalOrganizationProvisioningController } from './internal-organization-provisioning.controller';
import { ProvisionalOwnerProvisioningService } from './services/provisional-owner-provisioning.service';

/**
 * Aprovisionamiento interno de plataforma (`/internal/organizations/provision`): crea en una sola
 * transacción una cuenta provisional Enterprise —usuario `PROVISIONED`, organización, OWNER,
 * perfil manual con créditos y API key de integración— para probar la firma por API sin pasar por
 * `signature-app`, Stripe, CAPTCHA, OTP ni contraseña.
 *
 * No escribe nada por su cuenta salvo `platform_provisioning_requests`: cada paso lo hace el
 * módulo dueño con el `EntityManager` de la transacción (`UserService`, `AccountService`,
 * `BillingProfileProvisioningService`, `RegisterManualSubscriptionBillingUseCase`,
 * `IssuePlatformApiKeyUseCase`). `BillingModule` se importa por el registro manual de periodos; ese
 * camino no llama a Stripe.
 *
 * No está en el `include` del Swagger público (`main.ts`) y su controller lleva
 * `@ApiExcludeController()`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PlatformProvisioningRequestEntity]),
    UserModule,
    AccountModule,
    RolesModule,
    BillingProvisioningModule,
    BillingModule,
    ApiKeyModule,
  ],
  controllers: [InternalOrganizationProvisioningController],
  providers: [
    ProvisionalOwnerProvisioningService,
    ProvisionProvisionalEnterpriseAccountUseCase,
  ],
})
export class PlatformProvisioningModule {}

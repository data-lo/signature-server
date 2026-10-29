import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizationPermissionsService } from './organization-permissions.service';
import { OrganizationPermissionsController } from './organization-permissions.controller';
import { GetOrganizationPermissionsUseCase } from './applications/get-organization-permissions.use-case';
import { CreateOrganizationPermissionUseCase } from './applications/create-organization-permission.use-case';
import { UpdateOrganizationPermissionUseCase } from './applications/update-organization-permission.use-case';
import { DeleteOrganizationPermissionUseCase } from './applications/delete-organization-permission.use-case';
import { GetMemberPermissionsUseCase } from './applications/get-member-permissions.use-case';
import { AssignMemberPermissionsUseCase } from './applications/assign-member-permissions.use-case';
import { OrganizationPermissionEntity } from './entities/organization-permission.entity';
import { AccountPermissionEntity } from './entities/account-permission.entity';
import { AccountEntity } from 'src/account/entities/account.entity';
import { RolesModule } from 'src/roles/roles.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrganizationPermissionEntity,
      AccountPermissionEntity,
      AccountEntity,
    ]),
    RolesModule,
  ],
  controllers: [OrganizationPermissionsController],
  providers: [
    OrganizationPermissionsService,
    GetOrganizationPermissionsUseCase,
    CreateOrganizationPermissionUseCase,
    UpdateOrganizationPermissionUseCase,
    DeleteOrganizationPermissionUseCase,
    GetMemberPermissionsUseCase,
    AssignMemberPermissionsUseCase,
  ],
  exports: [
    OrganizationPermissionsService,
    GetMemberPermissionsUseCase,
    AssignMemberPermissionsUseCase,
  ],
})
export class OrganizationPermissionsModule {}

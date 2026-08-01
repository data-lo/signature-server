import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizationPermissionsService } from './organization-permissions.service';
import { OrganizationPermissionsController } from './organization-permissions.controller';
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
  providers: [OrganizationPermissionsService],
  exports: [OrganizationPermissionsService],
})
export class OrganizationPermissionsModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';
import { OrganizationRolesController } from './organization-roles.controller';
import { GetSystemRolesUseCase } from './applications/get-system-roles.use-case';
import { ListOrganizationRolesUseCase } from './applications/list-organization-roles.use-case';
import { CreateOrganizationRoleUseCase } from './applications/create-organization-role.use-case';
import { UpdateOrganizationRoleUseCase } from './applications/update-organization-role.use-case';
import { RoleEntity } from './entities/role.entity';
import { ResourceEntity } from './entities/resource.entity';
import { ActionEntity } from './entities/action.entity';
import { PermissionEntity } from './entities/permission.entity';
import { RolePermissionEntity } from './entities/role-permission.entity';
import { AccountEntity } from 'src/account/entities/account.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RoleEntity,
      ResourceEntity,
      ActionEntity,
      PermissionEntity,
      RolePermissionEntity,
      // Sólo la entidad, no AccountModule: RolesService resuelve la membresía del llamador por
      // su cuenta (assertHasOrganizationPermission), igual que AccountService/
      // OrganizationPermissionsService — importar AccountModule aquí crearía un ciclo real
      // (AccountModule ya importa RolesModule, directo y vía OrganizationPermissionsModule).
      AccountEntity,
    ]),
  ],
  controllers: [RolesController, OrganizationRolesController],
  providers: [
    RolesService,
    GetSystemRolesUseCase,
    ListOrganizationRolesUseCase,
    CreateOrganizationRoleUseCase,
    UpdateOrganizationRoleUseCase,
  ],
  exports: [RolesService],
})
export class RolesModule {}

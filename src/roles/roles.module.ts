import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';
import { RoleEntity } from './entities/role.entity';
import { ResourceEntity } from './entities/resource.entity';
import { ActionEntity } from './entities/action.entity';
import { PermissionEntity } from './entities/permission.entity';
import { RolePermissionEntity } from './entities/role-permission.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RoleEntity,
      ResourceEntity,
      ActionEntity,
      PermissionEntity,
      RolePermissionEntity,
    ]),
  ],
  controllers: [RolesController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}

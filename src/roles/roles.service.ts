import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoleEntity } from './entities/role.entity';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { RoleData } from './interfaces/response/role-response';

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(RoleEntity)
    private readonly roleRepository: Repository<RoleEntity>,
  ) {}

  async findAllSystemRoles(): Promise<BaseResponse<RoleData[]>> {
    const roles = await this.roleRepository.find({
      where: { isSystemRole: true },
      order: { name: 'ASC' },
    });

    return {
      success: true,
      message: 'Roles del sistema obtenidos correctamente',
      data: roles.map((role) => ({
        id: role.id,
        name: role.name,
        isSystemRole: role.isSystemRole,
      })),
    };
  }
}

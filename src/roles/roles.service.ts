import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoleEntity } from './entities/role.entity';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { RoleData } from './interfaces/response/role-response';
import { SYSTEM_ROLE_NAME_ENUM } from './enums/system-role-name.enum';

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(RoleEntity)
    private readonly roleRepository: Repository<RoleEntity>,
  ) {}

  /**
   * Resuelve un rol del sistema por nombre (ADMIN/MEMBER). Se usa al asignar
   * el rol por defecto de una membresía nueva (cuenta personal, organización).
   * Si falta (el seed `npm run seed:roles` no se ha corrido) falla con un
   * error claro en vez de dejar la membresía sin rol silenciosamente.
   */
  async findSystemRoleByName(name: SYSTEM_ROLE_NAME_ENUM): Promise<RoleEntity> {
    const role = await this.roleRepository.findOne({
      where: { name, isSystemRole: true },
    });

    if (!role) {
      throw new InternalServerErrorException(
        `El rol de sistema ${name} no está sembrado. Corre "npm run seed:roles".`,
      );
    }

    return role;
  }

  /** Verifica que un roleId exista (usado al validar el body de account-member). */
  async findByIdOrFail(id: string): Promise<RoleEntity> {
    const role = await this.roleRepository.findOne({ where: { id } });

    if (!role) {
      throw new NotFoundException(`Rol con ID ${id} no encontrado`);
    }

    return role;
  }

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

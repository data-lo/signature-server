import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RolesService } from './roles.service';
import { RoleListResponse } from './interfaces/response/role-response';

@ApiTags('Roles')
@ApiBearerAuth('access-token')
@Controller('api/v1/roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @ApiOperation({
    summary: 'Obtener los roles del sistema',
    description:
      'Retorna los roles seed (isSystemRole = true), p. ej. para poblar el modal de invitación de miembros',
  })
  @ApiResponse({
    status: 200,
    description: 'Roles del sistema obtenidos correctamente',
    type: RoleListResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  findAllSystemRoles() {
    return this.rolesService.findAllSystemRoles();
  }
}

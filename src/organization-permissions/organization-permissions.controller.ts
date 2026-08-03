import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

import { OrganizationPermissionsService } from './organization-permissions.service';
import { CreateOrganizationPermissionDto } from './dto/create-organization-permission.dto';
import { UpdateOrganizationPermissionDto } from './dto/update-organization-permission.dto';
import {
  OrganizationPermissionListResponse,
  OrganizationPermissionResponse,
} from './interfaces/response/organization-permission-response';
import {
  BadRequestResponse,
  BaseResponse,
} from 'src/interfaces/api-response.dto';

@ApiTags('Organization Permissions')
@ApiBearerAuth('access-token')
@Controller('api/v1/organizations/:organizationId/permissions')
export class OrganizationPermissionsController {
  constructor(
    private readonly organizationPermissionsService: OrganizationPermissionsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Listar el catálogo de permisos de una organización',
    description: 'Solo un ADMIN activo de esa organización puede listarlos.',
  })
  @ApiParam({ name: 'organizationId', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Permisos obtenidos correctamente',
    type: OrganizationPermissionListResponse,
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es ADMIN de esta organización',
  })
  findAll(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
  ) {
    return this.organizationPermissionsService.findAllForOrganization(
      user.sub,
      organizationId,
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Crear un permiso en el catálogo de la organización',
    description:
      'Solo un ADMIN activo de esa organización puede hacerlo. El nombre debe ser único dentro de la organización.',
  })
  @ApiParam({ name: 'organizationId', format: 'uuid' })
  @ApiResponse({
    status: 201,
    description: 'Permiso creado correctamente',
    type: OrganizationPermissionResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Los datos enviados son inválidos o incompletos',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es ADMIN de esta organización',
  })
  create(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
    @Body() dto: CreateOrganizationPermissionDto,
  ) {
    return this.organizationPermissionsService.create(
      user.sub,
      organizationId,
      dto,
    );
  }

  @Patch(':permissionId')
  @ApiOperation({
    summary: 'Modificar un permiso del catálogo (nombre y/o estatus)',
    description: 'Solo un ADMIN activo de esa organización puede hacerlo.',
  })
  @ApiParam({ name: 'organizationId', format: 'uuid' })
  @ApiParam({ name: 'permissionId', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Permiso actualizado correctamente',
    type: OrganizationPermissionResponse,
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es ADMIN de esta organización',
  })
  @ApiResponse({ status: 404, description: 'Permiso no encontrado' })
  update(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
    @Param('permissionId') permissionId: string,
    @Body() dto: UpdateOrganizationPermissionDto,
  ) {
    return this.organizationPermissionsService.update(
      user.sub,
      organizationId,
      permissionId,
      dto,
    );
  }

  @Delete(':permissionId')
  @ApiOperation({
    summary: 'Eliminar un permiso del catálogo',
    description:
      'Solo un ADMIN activo de esa organización puede hacerlo. Elimina también la asignación del permiso en cualquier miembro que lo tuviera.',
  })
  @ApiParam({ name: 'organizationId', format: 'uuid' })
  @ApiParam({ name: 'permissionId', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Permiso eliminado correctamente',
    type: BaseResponse,
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es ADMIN de esta organización',
  })
  @ApiResponse({ status: 404, description: 'Permiso no encontrado' })
  remove(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
    @Param('permissionId') permissionId: string,
  ) {
    return this.organizationPermissionsService.remove(
      user.sub,
      organizationId,
      permissionId,
    );
  }
}

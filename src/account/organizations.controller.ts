// NestJS core
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

// Swagger
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

// Auth
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { ActiveAccountId } from 'src/auth/decorators/active-account-id.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

// Service
import { AccountService } from './account.service';
import { AccountMemberService } from './account-member.service';
import { OrganizationInvitationService } from './organization-invitation.service';
import { OrganizationPermissionsService } from 'src/organization-permissions/organization-permissions.service';

// DTOs
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { AssignMemberPermissionsDto } from 'src/organization-permissions/dto/assign-member-permissions.dto';
import { AccountResponse } from './interfaces/response/account-response';
import {
  AccountMemberResponse,
  OrganizationMemberListResponse,
} from './interfaces/response/account-member-response';
import { MemberPermissionsResponse } from 'src/organization-permissions/interfaces/response/organization-permission-response';
import {
  BadRequestResponse,
  BaseResponse,
} from 'src/interfaces/api-response.dto';

@ApiTags('Organizations')
@ApiBearerAuth('access-token')
@Controller('api/v1/organizations')
export class OrganizationsController {
  constructor(
    private readonly accountService: AccountService,
    private readonly accountMemberService: AccountMemberService,
    private readonly organizationInvitationService: OrganizationInvitationService,
    private readonly organizationPermissionsService: OrganizationPermissionsService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Crear una organización',
    description:
      'Crea de forma transaccional la Account(ORGANIZATION), su OrganizationDetail y la membresía con el rol de sistema ADMIN del usuario autenticado (el creador queda como administrador de inmediato), y refresca el catálogo de cuentas en Redis',
  })
  @ApiResponse({
    status: 201,
    description: 'Organización creada correctamente',
    type: AccountResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Los datos enviados son inválidos o incompletos',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateOrganizationDto) {
    return this.accountService.createOrganization(user.sub, dto);
  }

  @Post('invite')
  @ApiOperation({
    summary: 'Invitar a un nuevo miembro a la organización activa',
    description:
      'Valida el payload y que el llamador sea ADMIN de la organización activa (X-Account-Id), persiste la invitación (PENDING) con un token único y publica el evento organization.member.invited en Kafka — el worker consumidor envía el correo vía SendGrid (ver OrganizationInvitationEventsConsumer). Responde en cuanto persiste, sin esperar al envío del correo.',
  })
  @ApiHeader({
    name: 'X-Account-Id',
    description:
      'UUID de la organización activa. El llamador debe ser ADMIN de esa cuenta.',
    required: true,
  })
  @ApiBody({ type: InviteMemberDto })
  @ApiResponse({
    status: 201,
    description: 'Invitación enviada correctamente',
  })
  @ApiResponse({
    status: 400,
    description:
      'Datos inválidos, falta el header X-Account-Id, o la cuenta activa no es de tipo ORGANIZATION',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es ADMIN de la organización activa',
  })
  async invite(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string,
    @Body() dto: InviteMemberDto,
  ) {
    const { data } = await this.accountService.inviteMember(
      user.sub,
      accountId,
      dto,
    );

    await this.organizationInvitationService.create({
      organizationId: data.organizationId,
      roleId: dto.roleId,
      invitedBy: user.sub,
      email: dto.email,
    });

    return {
      success: true,
      message: 'Invitación enviada correctamente',
      data: null,
    };
  }

  @Get(':organizationId/members')
  @ApiOperation({
    summary: 'Listar los miembros de una organización',
    description:
      'Email, RFC, rol asignado y fecha de ingreso de cada miembro activo. Solo un miembro con permiso ORGANIZATION:READ (rol ADMIN) puede listarlos.',
  })
  @ApiParam({
    name: 'organizationId',
    description: 'UUID de la organización',
    format: 'uuid',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de miembros obtenida correctamente',
    type: OrganizationMemberListResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es ADMIN de esta organización',
  })
  findMembers(
    @CurrentUser() user: JwtPayload,
    @Param('organizationId') organizationId: string,
  ) {
    return this.accountMemberService.findMembersForOrganizationDetailed(
      user.sub,
      organizationId,
    );
  }

  @Patch('members/:accountId/role')
  @ApiOperation({
    summary: 'Cambiar el rol de un miembro',
    description:
      'Solo un ADMIN activo de esa organización puede hacerlo. Rechaza degradar al único ADMIN activo (dejaría la organización sin administrador).',
  })
  @ApiParam({
    name: 'accountId',
    description: 'UUID de la membresía (accountId) a actualizar',
    format: 'uuid',
  })
  @ApiResponse({
    status: 200,
    description: 'Rol actualizado correctamente',
    type: AccountMemberResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es ADMIN de esta organización',
  })
  @ApiResponse({
    status: 409,
    description:
      'El miembro objetivo es el único ADMIN activo de la organización',
  })
  updateMemberRole(
    @CurrentUser() user: JwtPayload,
    @Param('accountId') accountId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.accountMemberService.update(user.sub, accountId, {
      roleId: dto.roleId,
    });
  }

  @Delete('members/:accountId')
  @ApiOperation({
    summary: 'Eliminar (revocar acceso de) un miembro de la organización',
    description:
      'Soft-delete: marca la membresía como no vigente. Solo un ADMIN activo de esa organización puede hacerlo. Rechaza eliminar al único ADMIN activo.',
  })
  @ApiParam({
    name: 'accountId',
    description: 'UUID de la membresía (accountId) a eliminar',
    format: 'uuid',
  })
  @ApiResponse({
    status: 200,
    description: 'Acceso revocado correctamente',
    type: BaseResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es ADMIN de esta organización',
  })
  @ApiResponse({
    status: 409,
    description:
      'El miembro objetivo es el único ADMIN activo de la organización',
  })
  removeMember(
    @CurrentUser() user: JwtPayload,
    @Param('accountId') accountId: string,
  ) {
    return this.accountMemberService.remove(user.sub, accountId);
  }

  @Get('members/:accountId/permissions')
  @ApiOperation({
    summary: 'Obtener los permisos actualmente asignados a un miembro',
    description: 'Solo un ADMIN activo de esa organización puede consultarlo.',
  })
  @ApiParam({
    name: 'accountId',
    description: 'UUID de la membresía (accountId) a consultar',
    format: 'uuid',
  })
  @ApiResponse({
    status: 200,
    description: 'Permisos del miembro obtenidos correctamente',
    type: MemberPermissionsResponse,
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es ADMIN de esta organización',
  })
  findMemberPermissions(
    @CurrentUser() user: JwtPayload,
    @Param('accountId') accountId: string,
  ) {
    return this.organizationPermissionsService.findMemberPermissions(
      user.sub,
      accountId,
    );
  }

  @Patch('members/:accountId/permissions')
  @ApiOperation({
    summary: 'Actualizar la lista de permisos asignados a un miembro',
    description:
      'Reemplaza por completo la lista de permisos asignados. Solo un ADMIN activo de esa organización puede hacerlo.',
  })
  @ApiParam({
    name: 'accountId',
    description: 'UUID de la membresía (accountId) a actualizar',
    format: 'uuid',
  })
  @ApiResponse({
    status: 200,
    description: 'Permisos del miembro actualizados correctamente',
    type: MemberPermissionsResponse,
  })
  @ApiResponse({
    status: 400,
    description:
      'Uno o más permisos no pertenecen al catálogo de esta organización',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es ADMIN de esta organización',
  })
  assignMemberPermissions(
    @CurrentUser() user: JwtPayload,
    @Param('accountId') accountId: string,
    @Body() dto: AssignMemberPermissionsDto,
  ) {
    return this.organizationPermissionsService.assignToMember(
      user.sub,
      accountId,
      dto.permissionIds,
    );
  }
}

// NestJS core
import { Body, Controller, Get, Param, Post } from '@nestjs/common';

// Swagger
import {
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

// Auth
import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';

// Service
import { OrganizationInvitationService } from './organization-invitation.service';

// DTOs
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { OrganizationInvitationPreviewResponse } from './interfaces/response/organization-invitation-response';
import { BaseResponse, NotFoundResponse } from 'src/interfaces/api-response.dto';

/**
 * Rutas públicas (sin JWT ni x-api-key, ver SkipJwtAuth) consumidas desde /join antes de que
 * el invitado inicie sesión — el token de la invitación es la única credencial (ver docblock
 * de OrganizationInvitationService).
 */
@ApiTags('Organization Invitations')
@Controller('api/v1/organizations/invitations')
export class OrganizationInvitationsController {
  constructor(
    private readonly organizationInvitationService: OrganizationInvitationService,
  ) {}

  @Get(':token')
  @SkipJwtAuth()
  @ApiOperation({
    summary: 'Consultar una invitación por su token',
    description:
      'Público (sin JWT) — usado por /join en el frontend para mostrar a qué organización invita el enlace antes de pedir el RFC.',
  })
  @ApiParam({ name: 'token', description: 'Token de la invitación' })
  @ApiResponse({
    status: 200,
    description: 'Invitación obtenida correctamente',
    type: OrganizationInvitationPreviewResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'No existe ninguna invitación con ese token',
    type: NotFoundResponse,
  })
  getPreview(@Param('token') token: string) {
    return this.organizationInvitationService.getPreview(token);
  }

  @Post(':token/accept')
  @SkipJwtAuth()
  @ApiOperation({
    summary: 'Aceptar una invitación (usuario ya registrado)',
    description:
      'Público (sin JWT) — Camino A de la historia: resuelve al usuario por RFC (no requiere sesión iniciada) y crea su membresía en la organización.',
  })
  @ApiParam({ name: 'token', description: 'Token de la invitación' })
  @ApiResponse({
    status: 200,
    description: 'Te uniste a la organización correctamente',
    type: BaseResponse,
  })
  @ApiResponse({
    status: 404,
    description: 'Invitación no encontrada, o ningún usuario registrado con ese RFC',
    type: NotFoundResponse,
  })
  @ApiResponse({
    status: 409,
    description: 'La invitación ya fue utilizada, o el usuario ya es miembro de la organización',
  })
  @ApiResponse({
    status: 410,
    description: 'La invitación ya expiró',
  })
  accept(@Param('token') token: string, @Body() dto: AcceptInvitationDto) {
    return this.organizationInvitationService.acceptByRfc(token, dto.rfc);
  }
}

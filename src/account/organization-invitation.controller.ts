// NestJS core
import { Body, Controller, Get, Param, Post } from '@nestjs/common';

// Swagger
import { ApiTags } from '@nestjs/swagger';

// Auth
import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';

// Service
import { OrganizationInvitationService } from './organization-invitation.service';

// DTOs
import { AcceptInvitationDto } from './dto/accept-invitation.dto';

// Docs
import { ApiGetInvitationPreview } from './docs/api-get-invitation-preview.docs';
import { ApiAcceptInvitation } from './docs/api-accept-invitation.docs';

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
  @ApiGetInvitationPreview()
  getPreview(@Param('token') token: string) {
    return this.organizationInvitationService.getPreview(token);
  }

  @Post(':token/accept')
  @SkipJwtAuth()
  @ApiAcceptInvitation()
  accept(@Param('token') token: string, @Body() dto: AcceptInvitationDto) {
    return this.organizationInvitationService.acceptByRfc(token, dto.rfc);
  }
}

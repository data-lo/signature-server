// NestJS core
import { Body, Controller, Get, Param, Post } from '@nestjs/common';

// Swagger
import { ApiTags } from '@nestjs/swagger';

// Auth
import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';

// Use cases
import { GetOrganizationInvitationPreviewUseCase } from './applications/get-organization-invitation-preview.use-case';
import { AcceptOrganizationInvitationUseCase } from './applications/accept-organization-invitation.use-case';

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
    private readonly getInvitationPreview: GetOrganizationInvitationPreviewUseCase,
    private readonly acceptInvitation: AcceptOrganizationInvitationUseCase,
  ) {}

  @Get(':token')
  @SkipJwtAuth()
  @ApiGetInvitationPreview()
  getPreview(@Param('token') token: string) {
    return this.getInvitationPreview.execute(token);
  }

  @Post(':token/accept')
  @SkipJwtAuth()
  @ApiAcceptInvitation()
  accept(@Param('token') token: string, @Body() dto: AcceptInvitationDto) {
    return this.acceptInvitation.execute(token, dto.rfc);
  }
}

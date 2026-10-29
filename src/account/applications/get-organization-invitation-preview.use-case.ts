import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { OrganizationInvitationPreviewData } from '../interfaces/response/organization-invitation-response';
import { OrganizationInvitationService } from '../organization-invitation.service';

/**
 * `GET /api/v1/organizations/invitations/:token`: qué hay detrás de un enlace de invitación.
 *
 * Es público a propósito: quien llega desde el correo todavía no tiene sesión, y necesita ver a
 * qué organización lo invitan antes de decidir si se registra o entra con su cuenta.
 *
 * Devuelve el estado sin exigir que siga pendiente —a diferencia de aceptarla—: si la
 * invitación venció o ya se usó, `/join` puede decirlo con claridad en vez de mostrar un error
 * suelto.
 */
@Injectable()
export class GetOrganizationInvitationPreviewUseCase {
  constructor(
    private readonly organizationInvitationService: OrganizationInvitationService,
  ) {}

  async execute(
    token: string,
  ): Promise<BaseResponse<OrganizationInvitationPreviewData>> {
    const invitation =
      await this.organizationInvitationService.resolveInvitation(token);

    return {
      success: true,
      message: 'Invitación obtenida correctamente',
      data: {
        organizationId: invitation.organizationId,
        organizationName: invitation.organization.name,
        email: invitation.email,
        status: invitation.status,
      },
    };
  }
}

import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { OrganizationInvitationPreviewData } from '../interfaces/response/organization-invitation-response';
import { OrganizationInvitationService } from '../organization-invitation.service';

/**
 * Expone a qué organización invita un enlace (`GET /api/v1/organizations/invitations/:token`).
 *
 * Es público a propósito: quien llega desde el correo aún no tiene sesión y necesita ver a qué lo
 * invitan antes de decidir si se registra o entra con su cuenta.
 *
 * Devuelve el estado sin exigir que la invitación siga pendiente —a diferencia de aceptarla— para
 * que `/join` pueda decir con claridad que venció o ya se usó.
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

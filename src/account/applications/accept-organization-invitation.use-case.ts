import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { OrganizationInvitationService } from '../organization-invitation.service';

/**
 * Consuma una invitación cuando el invitado ya tiene cuenta
 * (`POST /api/v1/organizations/invitations/:token/accept`).
 *
 * Va sin JWT a propósito: el invitado puede no tener sesión, y el token del correo es la credencial.
 * Resuelve la identidad por RFC y no comparando correos, porque la dirección a la que se envió el
 * enlace es sólo el canal de entrega, no necesariamente el correo con el que esa persona ya tiene
 * cuenta.
 *
 * Tradeoff aceptado por la historia: quien conozca el token y el RFC —dato semi-público en México—
 * puede consumar la invitación, ya que este paso no pide contraseña.
 */
@Injectable()
export class AcceptOrganizationInvitationUseCase {
  constructor(
    private readonly organizationInvitationService: OrganizationInvitationService,
  ) {}

  async execute(token: string, rfc: string): Promise<BaseResponse<null>> {
    const invitation =
      await this.organizationInvitationService.resolveInvitation(token);

    this.organizationInvitationService.assertPending(invitation);

    const user =
      await this.organizationInvitationService.findUserByRfcOrFail(rfc);

    await this.organizationInvitationService.finalizeAcceptance(
      invitation,
      user,
    );

    return {
      success: true,
      message: 'Te uniste a la organización correctamente',
      data: null,
    };
  }
}

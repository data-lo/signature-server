import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { OrganizationInvitationService } from '../organization-invitation.service';

/**
 * `POST /api/v1/organizations/invitations/:token/accept`: camino A de la historia — el invitado
 * ya tiene cuenta y se une con su RFC.
 *
 * Sin JWT a propósito: el invitado puede no tener sesión iniciada (Escenario 5 de la historia) y
 * el token del correo es la credencial. La identidad se resuelve por RFC y no comparando
 * correos contra la invitación: la dirección a la que se mandó el enlace es sólo el canal de
 * entrega, no necesariamente el correo con el que esa persona ya tiene cuenta.
 *
 * Nota de seguridad heredada de la historia: quien conozca el token y el RFC del invitado —dato
 * semi-público en México— puede consumar la invitación. Es el tradeoff que la propia historia
 * especifica al no pedir contraseña en este paso.
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

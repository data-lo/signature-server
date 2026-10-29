import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { OrganizationInvitationService } from '../organization-invitation.service';

/**
 * `POST /api/v1/organizations/invitations/:token/accept`: el único camino para unirse a una
 * organización por invitación, tenga la persona cuenta desde antes o la acabe de crear.
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

  /**
   * Une a la persona dueña del RFC a la organización de la invitación.
   *
   * Lo llaman los dos caminos de `/join`: quien ya tenía cuenta y confirma, y el formulario de
   * registro justo después de crear una cuenta nueva. Toda la lógica vive en
   * `OrganizationInvitationService.acceptByRfc`.
   *
   * @param token - Token de la invitación.
   * @param rfc - RFC de quien se une.
   * @returns Confirmación, sin datos.
   *
   * @throws {NotFoundException} (404) Token inexistente o RFC sin cuenta.
   * @throws {ConflictException} (409) Invitación ya usada, o la persona ya es miembro activo.
   * @throws {GoneException} (410) Invitación expirada.
   *
   * @example
   * ```ts
   * await acceptInvitation.execute(token, 'XAXX010101000');
   * ```
   */
  async execute(token: string, rfc: string): Promise<BaseResponse<null>> {
    await this.organizationInvitationService.acceptByRfc(token, rfc);

    return {
      success: true,
      message: 'Te uniste a la organización correctamente',
      data: null,
    };
  }
}

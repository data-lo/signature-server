import { BadRequestException, Injectable } from '@nestjs/common';

import { AccountMemberService } from 'src/account/account-member.service';
import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

/** Un usuario que puede aprobar documentos en la organización activa, tal como se le ofrece a quien crea uno. */
export interface DocumentApproverData {
  /** Lo que se manda después en `documentData.reviewerUserId`. */
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
}

/**
 * `GET /documents/approvers`: quién puede aprobar un documento en la organización activa, para el
 * selector que aparece al marcar "Requiere aprobación" (historia "Corregir carga de aprobadores
 * al requerir aprobación durante la creación de documentos").
 *
 * Antes el frontend armaba esta lista con `GET /organizations/:id/members`, que exige
 * `MEMBER.READ`: quien sólo podía crear documentos recibía 403 y el selector se quedaba vacío, sin
 * poder terminar de configurar la aprobación. Este endpoint pide el mismo permiso que crear el
 * documento (`DOCUMENT.CREATE`) y a cambio devuelve lo mínimo para elegir a alguien: sólo a los
 * miembros que pueden aprobar, y de ellos sólo id, correo y nombre. Nada de RFC, rol, permisos ni
 * estado, que es lo que `MEMBER.READ` sí abre.
 *
 * La organización sale del contexto autorizado —la membresía activa del llamador, resuelta por
 * `PermissionsGuard`—, nunca de la petición: no hay forma de pedir los aprobadores de otra.
 */
@Injectable()
export class GetDocumentApproversUseCase {
  constructor(private readonly accountMemberService: AccountMemberService) {}

  /**
   * Lista a los aprobadores elegibles de la organización activa.
   *
   * @param authorization - Contexto que dejó `PermissionsGuard` para `DOCUMENT + CREATE`.
   * @returns Los miembros activos cuyo rol concede `DOCUMENT.APPROVE`, por antigüedad.
   *
   * @throws {BadRequestException} (400) Si la cuenta activa es PERSONAL: sin organización no hay
   *   a quién pedirle una aprobación, igual que al crear el documento.
   *
   * @example
   * ```ts
   * await getDocumentApprovers.execute(authorization);
   * // { data: [{ userId: 'user-1', email: 'ana@empresa.com', firstName: 'Ana', lastName: 'Ruiz' }] }
   * ```
   */
  async execute(
    authorization: AuthorizationContext,
  ): Promise<BaseResponse<DocumentApproverData[]>> {
    if (!authorization.organizationId) {
      throw new BadRequestException(
        'Solo las cuentas de tipo ORGANIZATION pueden asignar un usuario aprobador',
      );
    }

    const members =
      await this.accountMemberService.listActiveMembersWithPermission(
        authorization.organizationId,
        RESOURCE_KEY_ENUM.DOCUMENT,
        ACTION_KEY_ENUM.APPROVE,
      );

    return {
      success: true,
      message: 'Aprobadores obtenidos correctamente',
      data: members.map((member) => ({
        userId: member.userId,
        email: member.user?.email ?? member.email,
        firstName: member.user?.firstName ?? '',
        lastName: member.user?.lastName ?? '',
      })),
    };
  }
}

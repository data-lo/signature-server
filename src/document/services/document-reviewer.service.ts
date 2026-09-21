import { BadRequestException, Injectable } from '@nestjs/common';

import { AccountMemberService } from 'src/account/account-member.service';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

/**
 * Comprueba que el usuario elegido para aprobar un documento pueda realmente hacerlo, y resuelve
 * a qué cuenta se ancla su colaborador REVIEWER (historia "Implementar flujo de aprobación previo
 * al proceso de firma").
 *
 * Vive aparte del caso de uso de creación por dos razones: ese caso de uso ya orquesta media
 * docena de cosas y esta comprobación se puede probar sola, y porque el día que la aprobación se
 * pueda reasignar habrá un segundo consumidor de exactamente esta regla.
 *
 * Las cuatro validaciones de la historia se resuelven en dos consultas, no en cuatro: "existe",
 * "pertenece a la organización" y "tiene permiso para aprobar" son la misma pregunta desde tres
 * ángulos —hay una membresía activa suya en esta organización cuyo rol concede `DOCUMENT.APPROVE`—
 * y separarlas sólo produciría mensajes de error que filtran si un correo ajeno existe o no en la
 * plataforma. La cuarta, "un solo reviewer", la garantiza el contrato: `reviewerUserId` es un
 * campo, no un arreglo.
 */
@Injectable()
export class DocumentReviewerService {
  constructor(private readonly accountMemberService: AccountMemberService) {}

  /**
   * Valida al aprobador elegido y devuelve la cuenta a la que se anclará su colaborador.
   *
   * La cuenta es la PERSONAL del aprobador y no su membresía en la organización, igual que para
   * cualquier otro colaborador (ver el docblock de `CollaboratorEntity.accountId`): lo que firma,
   * aprueba o rechaza es la persona, y anclar a la membresía dejaría el documento colgando de un
   * acceso que puede revocarse.
   *
   * @param reviewerUserId - Usuario elegido en `documentData.reviewerUserId`.
   * @param organizationId - Organización de la cuenta activa con la que se crea el documento.
   * @returns El id de la cuenta PERSONAL del aprobador, listo para `collaborator.accountId`.
   *
   * @throws {BadRequestException} (400) Si el documento se crea fuera de una organización, o si
   *   el usuario elegido no es miembro activo de ella o su rol no concede `DOCUMENT.APPROVE`.
   * @throws {NotFoundException} (404) Si el usuario no tiene cuenta PERSONAL — no debería ocurrir:
   *   toda alta crea una.
   *
   * @example
   * ```ts
   * const accountId = await documentReviewerService.resolveReviewerAccountId(
   *   'user-aprobador',
   *   'org-1',
   * );
   * ```
   */
  async resolveReviewerAccountId(
    reviewerUserId: string,
    organizationId: string | null,
  ): Promise<string> {
    /**
     * Sin organización no hay a quién pedirle la aprobación: una cuenta PERSONAL no tiene
     * miembros ni roles que concedan `DOCUMENT.APPROVE`. El caso de uso ya rechaza antes
     * `requiresApproval` en cuentas personales; esto cierra la puerta también para quien llame a
     * este servicio por otro camino.
     */
    if (!organizationId) {
      throw new BadRequestException(
        'Solo las cuentas de tipo ORGANIZATION pueden asignar un usuario aprobador',
      );
    }

    const membership =
      await this.accountMemberService.findActiveMembershipWithPermission(
        reviewerUserId,
        organizationId,
        RESOURCE_KEY_ENUM.DOCUMENT,
        ACTION_KEY_ENUM.APPROVE,
      );

    /**
     * Un solo mensaje para los tres motivos (no existe, no es miembro, no tiene el permiso) y no
     * por pereza: distinguirlos le diría a cualquiera que pueda crear un documento si un
     * identificador de usuario existe en la plataforma y a qué organización pertenece. Quien
     * elige el aprobador lo hace de una lista que el propio backend le dio, así que llegar aquí
     * significa que esa lista quedó vieja — y la salida es la misma en los tres casos: volver a
     * elegir.
     */
    if (!membership) {
      throw new BadRequestException(
        'El usuario aprobador seleccionado no puede aprobar documentos en esta organización',
      );
    }

    return this.accountMemberService.findPersonalAccountId(reviewerUserId);
  }
}

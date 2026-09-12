import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { MissingActiveAccountException } from 'src/billing/exceptions/billing.exceptions';

import { AccountService } from '../account.service';
import { AccountMemberService } from '../account-member.service';
import { CreateOrganizationDto } from '../dto/create-organization.dto';
import { AccountData } from '../interfaces/response/account-response';

/**
 * `POST /api/v1/organizations`: crea una organización y deja a su creador dentro como
 * administrador.
 *
 * El alta va en una transacción (ver `saveOrganizationWithAdminAccount`); el refresco del
 * catálogo de Redis queda fuera de ella a propósito: es un cache y su fallo no debe deshacer una
 * organización que ya se creó bien.
 *
 * **Crear una organización ya no depende del plan.** Cualquier usuario que pertenezca a la cuenta
 * desde la que pide el alta puede crearla, esté en Free o sin suscripción. Lo que se paga es USARLA:
 * la organización nace sin `billing_profile` —ni plan Free, ni créditos de bienvenida— y
 * `GetBillingAccessUseCase` le responde sin plan y con todas las acciones en `false` hasta que
 * contrate una suscripción.
 */
@Injectable()
export class CreateOrganizationUseCase {
  constructor(
    private readonly accountService: AccountService,
    private readonly accountMemberService: AccountMemberService,
  ) {}

  /**
   * Crea la organización con su creador como ADMIN, sin consultar el plan de la cuenta activa.
   *
   * Conserva la comprobación de pertenencia que antes hacía, de paso, la validación de plan: la
   * cuenta activa la elige el cliente, así que se verifica que el usuario sea miembro activo de ella
   * antes de escribir nada.
   *
   * @param userId - Usuario autenticado, que queda como ADMIN de la organización nueva.
   * @param accountId - Cuenta activa (`X-Account-Id`) desde la que se pide el alta. NO es la
   *   organización que se crea, que todavía no existe.
   * @param dto - Datos de la organización: nombre, razón social y perfil opcional.
   * @returns La cuenta recién creada, ya en formato de entrada del catálogo de cuentas.
   *
   * @throws {MissingActiveAccountException} (400) Si la petición no manda `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si el usuario no es miembro activo de la cuenta activa.
   * @throws {NotFoundException} (404) Si el usuario autenticado ya no existe.
   *
   * @example
   * ```ts
   * await createOrganization.execute('user-1', 'account-1', {
   *   name: 'Acme',
   *   organizationName: 'Acme Corp S.A. de C.V.',
   * });
   * ```
   */
  async execute(
    userId: string,
    accountId: string,
    dto: CreateOrganizationDto,
  ): Promise<BaseResponse<AccountData>> {
    /**
     * Sin header se corta aquí, antes de consultar: TypeORM trata un `id` indefinido como "sin
     * condición", y la comprobación de membresía encontraría cualquier cuenta del usuario.
     */
    if (!accountId) {
      throw new MissingActiveAccountException();
    }

    await this.accountMemberService.assertIsActiveMember(userId, accountId);

    const currentUser = await this.accountService.findUserOrFail(userId);

    const fullAccount =
      await this.accountService.saveOrganizationWithAdminAccount(
        currentUser,
        dto,
      );

    await this.accountService.appendAccountToCatalog(userId, fullAccount);

    return {
      success: true,
      message: 'Organización creada correctamente',
      data: this.accountService.toCatalogEntry(fullAccount),
    };
  }
}

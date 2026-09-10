import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { AssertPlanActionUseCase } from 'src/billing/entitlements/assert-plan-action.use-case';
import { PLAN_ACTION_ENUM } from 'src/billing/entitlements/plan-entitlements.types';

import { AccountService } from '../account.service';
import { CreateOrganizationDto } from '../dto/create-organization.dto';
import { AccountData } from '../interfaces/response/account-response';

/**
 * Lo que ve quien intenta crear una organización sin plan que lo incluya.
 *
 * Lo redactó producto y viaja tal cual al usuario: dice qué pasa y qué hacer al respecto, que es
 * lo que la negativa genérica del módulo de facturación no puede decir sin nombrar este flujo.
 */
export const ORGANIZATION_ACCOUNT_DENIED_MESSAGE =
  'No disponible en plan Free. Contrata un plan para crear una organización.';

/**
 * `POST /api/v1/organizations`: crea una organización y deja a su creador dentro como
 * administrador.
 *
 * El alta va en una transacción (ver `saveOrganizationWithAdminAccount`); el refresco del
 * catálogo de Redis queda fuera de ella a propósito: es un cache y su fallo no debe deshacer una
 * organización que ya se creó bien.
 *
 * **La cuenta empresarial se paga, y esto es lo que lo hace cumplir.** El menú del frontend
 * deshabilita la opción cuando el plan no la incluye, pero eso es dibujo: la petición se puede
 * mandar a mano, con el botón forzado desde las herramientas del navegador o con un estado de
 * facturación cacheado de antes de una baja. La autorización se resuelve acá, contra el plan de
 * la cuenta activa y en el instante de ejecutar.
 */
@Injectable()
export class CreateOrganizationUseCase {
  constructor(
    private readonly accountService: AccountService,
    private readonly assertPlanAction: AssertPlanActionUseCase,
  ) {}

  /**
   * Crea la organización si el plan de la cuenta activa la incluye.
   *
   * @param userId Usuario autenticado, que queda como ADMIN de la organización nueva.
   * @param accountId Cuenta activa (`X-Account-Id`) contra cuyo plan se autoriza. NO es la
   *   organización que se está creando —todavía no existe—, sino el contexto desde el que se
   *   pide: la cuenta personal de quien paga, o la organización desde la que está trabajando.
   * @returns La cuenta recién creada, ya en formato de entrada del catálogo de cuentas.
   * @throws {MissingActiveAccountException} (400) Si la petición no manda `X-Account-Id`.
   * @throws {ForbiddenException} (403) Si el usuario no pertenece a la cuenta activa.
   * @throws {PlanActionNotIncludedException} (403) Si el plan de esa cuenta no incluye
   *   `ORGANIZATION_ACCOUNT`, que es el caso de Free y el de toda cuenta sin `billing_profile`.
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
     * Antes de tocar nada: el alta abre una transacción con dos escrituras y publica el catálogo
     * en Redis, y nada de eso debe llegar a ocurrir para una cuenta que no puede tener
     * organización.
     *
     * Una cuenta sin `billing_profile` cae acá igual que una Free, y no hace falta escribir esa
     * regla: `GetBillingAccessUseCase` ya responde los beneficios del plan gratuito cuando no
     * encuentra perfil (no crea ninguno al preguntar), y el gratuito no incluye esta acción.
     */
    await this.assertPlanAction.execute({
      userId,
      accountId,
      action: PLAN_ACTION_ENUM.ORGANIZATION_ACCOUNT,
      deniedMessage: ORGANIZATION_ACCOUNT_DENIED_MESSAGE,
    });

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

import { Injectable } from '@nestjs/common';
import {
  InsufficientDocumentCreditsException,
  PlanActionNotIncludedException,
} from '../exceptions/billing.exceptions';
import { GetBillingAccessUseCase } from './get-billing-access.use-case';
import type { PLAN_ACTION_ENUM } from './plan-entitlements.types';
import type { BillingAccessResponse } from './plan-entitlements.types';

export interface AssertPlanActionInput {
  userId: string;
  accountId: string;
  /** Qué se está intentando hacer, con el mismo símbolo que viaja en la respuesta al frontend. */
  action: PLAN_ACTION_ENUM;
  /**
   * Documentos que la acción va a consumir. Se omite en todo lo que no gasta saldo —branding,
   * expedientes, API—, y no vale `0` como "no aplica": pedirlo explícito obliga a decidirlo en
   * cada llamada en vez de heredar un valor por omisión que nadie miró.
   */
  requiredCredits?: number;
}

/**
 * La comprobación que de verdad autoriza una acción protegida.
 *
 * **`GET /payments/billing-state` no autoriza nada.** Lo que responde es para dibujar: qué
 * habilitar, qué ocultar, adónde mandar a mejorar el plan. Un cliente puede mandar la petición
 * sin haber pedido nunca esa respuesta, con una respuesta cacheada de hace una hora, o con la
 * cuenta activa cambiada entre una cosa y la otra — así que el permiso se vuelve a resolver acá,
 * contra el mismo mapa, en el instante de ejecutar.
 *
 * **Reutiliza `GetBillingAccessUseCase` en vez de repetir su consulta**, y eso es lo que
 * garantiza que la pantalla y el backend no puedan discrepar: si un día la resolución del plan
 * cambia (un beneficio negociado por cuenta, una caducidad de saldo), cambia para los dos a la
 * vez. Cuesta las mismas dos consultas que ya hace el dashboard, sobre un perfil que la petición
 * necesita de todos modos.
 *
 * **Distingue "no lo incluye tu plan" de "no te queda saldo"** con dos errores distintos, 403 y
 * 402, porque llevan al usuario a sitios opuestos: mejorar el plan o comprar documentos.
 * Colapsarlos mandaría a contratar de nuevo a quien ya tiene lo que necesita.
 *
 * Devuelve el estado completo para que el llamador no vuelva a pedirlo: quien acaba de
 * comprobar que puede crear un documento suele necesitar acto seguido el perfil y el saldo.
 *
 * Uso:
 *
 * ```ts
 * await this.assertPlanAction.execute({
 *   userId, accountId,
 *   action: PLAN_ACTION_ENUM.BULK_SIGNING,
 * });
 * ```
 */
@Injectable()
export class AssertPlanActionUseCase {
  constructor(private readonly getBillingAccess: GetBillingAccessUseCase) {}

  async execute(input: AssertPlanActionInput): Promise<BillingAccessResponse> {
    /**
     * Resuelve el propietario Y comprueba la membresía (`resolveOwner`): sin eso, mandar el
     * `X-Account-Id` de una organización ajena autorizaría contra el plan de esa organización.
     */
    const access = await this.getBillingAccess.execute({
      userId: input.userId,
      accountId: input.accountId,
    });

    if (!access.actions[input.action]) {
      throw new PlanActionNotIncludedException(
        input.action,
        access.currentPlanType,
      );
    }

    /**
     * El saldo se mira DESPUÉS del plan, y el orden importa para el mensaje: a quien no tiene la
     * funcionalidad hay que decirle que le falta plan, no que le falten documentos — comprar
     * saldo no le desbloquearía nada.
     */
    const requiredCredits = input.requiredCredits ?? 0;
    if (requiredCredits > 0 && access.creditsAvailable < requiredCredits) {
      throw new InsufficientDocumentCreditsException(
        requiredCredits,
        access.creditsAvailable,
      );
    }

    return access;
  }
}

import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from 'src/auth/decorators/public.decorator';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { RegisterManualSubscriptionBillingUseCase } from './register-manual-subscription-billing.use-case';
import { RegisterManualSubscriptionBillingDto } from './dto/register-manual-subscription-billing.dto';
import { ApiRegisterManualSubscriptionBilling } from './docs/api-register-manual-subscription-billing.docs';

export interface ManualSubscriptionBillingResponse {
  historyId: string;
  billingProfileId: string;
  planType: string;
  creditSlotId: string | null;
  periodStart: Date;
  periodEnd: Date;
  /** `true` si ese folio ya estaba registrado: la llamada no escribió nada. */
  alreadyRegistered: boolean;
}

/**
 * Superficie interna de facturación: lo que administración necesita para dar de alta un cobro
 * que no pasó por Stripe.
 *
 * **Por qué `@Public()` en un endpoint que concede planes.** En este proyecto ese decorador no
 * significa "abierto": significa "no valida JWT de usuario final, valida `x-api-key`" (ver
 * `JwtAuthGuard` y `ApiKeyGuard`, los dos guards globales). Es la frontera que el código ya usa
 * para lo que llaman sistemas y no personas, y es la que corresponde acá: quien registra un
 * cobro manual es el panel interno, no un usuario navegando con su sesión.
 *
 * Se eligió así y no con un rol de plataforma porque **no existe tal cosa en este dominio**: los
 * roles del proyecto (`SYSTEM_ROLE_NAME_ENUM.ADMIN`/`MEMBER`) describen la posición de alguien
 * DENTRO de una organización cliente, no del personal de la plataforma. Un ADMIN de una
 * organización no debe poder facturarse a sí mismo un plan, así que colgar de ese rol sería peor
 * que la API Key. Por eso `createdByUserId` viaja en el cuerpo y no sale del token: no hay token
 * de usuario del que sacarlo, y quien opera el panel es quien declara —y firma— quién registró
 * el cobro.
 *
 * El endpoint no aparece en el Swagger publicado: éste sólo incluye `UserModule`,
 * `DocumentModule`, `SignatureModule` y `AuthModule` (ver `main.ts`).
 */
@ApiTags('Billing — interno')
@Public()
@Controller('internal/billing/subscription-periods')
export class InternalSubscriptionBillingController {
  constructor(
    private readonly registerManualSubscriptionBilling: RegisterManualSubscriptionBillingUseCase,
  ) {}

  @Post()
  @ApiRegisterManualSubscriptionBilling()
  async register(
    @Body() dto: RegisterManualSubscriptionBillingDto,
  ): Promise<BaseResponse<ManualSubscriptionBillingResponse>> {
    const { history, alreadyRegistered } =
      await this.registerManualSubscriptionBilling.execute(dto);

    return {
      success: true,
      message: alreadyRegistered
        ? 'El periodo ya estaba registrado con esa referencia; no se acreditó de nuevo.'
        : 'Periodo facturado registrado correctamente',
      data: {
        historyId: history.id,
        billingProfileId: history.billingProfileId,
        planType: history.planType,
        creditSlotId: history.creditSlotId,
        periodStart: history.periodStart,
        periodEnd: history.periodEnd,
        alreadyRegistered,
      },
    };
  }
}

import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

/**
 * La petición no dijo desde qué cuenta se está contratando.
 *
 * No se adivina la cuenta del usuario aunque tenga una sola: quién paga determina a qué perfil
 * de facturación —y por tanto a qué saldo compartido— se cargan los documentos, y equivocarse
 * significa cobrarle a la organización lo que el usuario quería a título personal, o al revés.
 */
export class MissingActiveAccountException extends BadRequestException {
  constructor() {
    super('Falta el header X-Account-Id de la cuenta activa');
  }
}

/**
 * El precio pedido no existe en el catálogo local de planes recurrentes, o existe pero no se
 * puede vender ahora mismo (precio archivado, plan dado de baja, o fuera de su ventana de
 * vigencia).
 *
 * Es la guarda que impide abrir una sesión de pago por algo que no ofrecemos: sin ella,
 * cualquier usuario autenticado podría mandar un `price_...` de otro producto, archivado con un
 * importe viejo, o de un paquete de documentos (que no es una suscripción), y obtener una URL de
 * pago perfectamente válida.
 *
 * 404 y no 400: desde fuera es indistinguible "ese precio no existe" de "ese precio ya no se
 * ofrece", y responder distinto permitiría sondear el catálogo interno.
 */
export class SubscriptionPriceNotAvailableException extends NotFoundException {
  constructor() {
    super('El plan seleccionado no está disponible.');
  }
}

/**
 * Una cuenta de tipo ORGANIZATION sin `organization_id`. No es un error del usuario: es una fila
 * imposible según el propio modelo (ver `AccountEntity.organizationId`, NULL sólo en PERSONAL),
 * y facturar a ciegas elegiría mal el propietario del saldo.
 *
 * 500 a propósito: reintentar no lo arregla y el detalle accionable queda en el log del servidor.
 */
export class InconsistentOrganizationAccountException extends InternalServerErrorException {
  constructor(accountId: string) {
    super('No se pudo determinar la organización de la cuenta activa.');
    this.cause = `La cuenta ${accountId} es de tipo ORGANIZATION pero no tiene organization_id.`;
  }
}

/**
 * Llegó una factura pagada de una suscripción que no se puede asociar a ningún perfil local, ni
 * por `stripe_subscription_id` ni por `stripe_customer_id`.
 *
 * **Se lanza en vez de ignorarse** —a diferencia de un producto de Stripe que no es de nuestro
 * catálogo— porque aquí sí hubo un cobro real a un cliente: dar el evento por bueno dejaría a
 * alguien pagando sin recibir documentos y sin rastro del problema. El 5xx hace que Stripe
 * reintente durante días, que es tiempo suficiente para reparar el vínculo.
 */
export class BillingProfileNotFoundForInvoiceException extends InternalServerErrorException {
  constructor(reference: string) {
    super('No se encontró el perfil de facturación de la factura recibida.');
    this.cause = `Sin billing_profile para ${reference}.`;
  }
}

/**
 * La factura pagada corresponde a un `stripe_price_id` que no está en `plan_prices`, así que no
 * hay forma de saber cuántos documentos conceder.
 *
 * Mismo criterio que arriba: hubo cobro, así que se falla ruidosamente en vez de conceder un
 * número inventado de documentos o ninguno.
 */
export class PlanNotFoundForInvoiceException extends InternalServerErrorException {
  constructor(stripePriceId: string | null) {
    super('No se encontró el plan correspondiente a la factura recibida.');
    this.cause = `Sin plan_prices para el precio ${stripePriceId ?? '(desconocido)'}.`;
  }
}

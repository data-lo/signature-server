import {
  BadRequestException,
  ConflictException,
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
 * El propietario facturable ya tiene una suscripción vigente (`billing_profile.status = ACTIVE`)
 * y está pidiendo otra.
 *
 * Se corta ANTES de hablar con Stripe porque cada sesión de Checkout abierta es una suscripción
 * potencial: si el usuario la completa (dos pestañas, un doble clic en "Contratar", o un
 * miembro de la organización que no sabe que otro ya contrató), el propietario acaba con dos
 * suscripciones cobrándose en paralelo por el mismo perfil, y `stripe_subscription_id` sólo
 * puede apuntar a una — la otra quedaría cobrando sin conceder documentos y sin rastro local.
 * De paso evita la basura de `checkout_orders` en PENDING que nunca se van a reconciliar.
 *
 * Sólo bloquea ACTIVE: INCOMPLETE (nunca llegó a pagar), PAST_DUE (el cobro falló y quiere
 * arreglarlo) y CANCELED (quiere volver) son justamente los casos en los que hay que dejar
 * abrir un Checkout nuevo.
 *
 * 409 y no 400: la petición está bien formada, lo que choca es el estado actual del recurso, y
 * el frontend necesita distinguirlo para mandar al usuario al portal de facturación en vez de a
 * pagar otra vez.
 */
export class ActiveSubscriptionAlreadyExistsException extends ConflictException {
  constructor() {
    super(
      'Esta cuenta ya tiene una suscripción activa. Administra tu plan actual desde tu facturación en lugar de contratar uno nuevo.',
    );
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
 * La factura pagada corresponde a un `stripe_price_id` que no está en `catalog_prices`, así que no
 * hay forma de saber cuántos documentos conceder.
 *
 * Mismo criterio que arriba: hubo cobro, así que se falla ruidosamente en vez de conceder un
 * número inventado de documentos o ninguno.
 */
export class PlanNotFoundForInvoiceException extends InternalServerErrorException {
  constructor(stripePriceId: string | null) {
    super('No se encontró el plan correspondiente a la factura recibida.');
    this.cause = `Sin catalog_prices para el precio ${stripePriceId ?? '(desconocido)'}.`;
  }
}

/**
 * El perfil de facturación al que se quiere anotar un periodo no existe.
 *
 * 404 y no 500 porque el llamador legítimo de esto es el endpoint interno de facturación manual,
 * donde un id equivocado es un error de la petición y no del sistema. El adaptador de Stripe
 * nunca llega a lanzarla: resuelve el perfil antes y, si no lo encuentra, avisa y se retira sin
 * invocar el caso de uso.
 */
export class BillingProfileNotFoundForRegistrationException extends NotFoundException {
  constructor(billingProfileId: string) {
    super('No se encontró el perfil de facturación indicado.');
    this.cause = `Sin billing_profile con id ${billingProfileId}.`;
  }
}

/**
 * El `plan_type` que se quiere facturar no está en el catálogo local.
 *
 * Se comprueba aunque el plan venga de Stripe: `subscription_billing_history.plan_type` es clave
 * foránea a `plans`, y sin la fila el alta reventaría con una violación de constraint a mitad de
 * la transacción — un error ilegible en el log en vez de uno que dice qué plan falta.
 */
export class PlanNotFoundForRegistrationException extends NotFoundException {
  constructor(planType: string) {
    super('No se encontró el plan indicado.');
    this.cause = `Sin plans con plan_type ${planType}.`;
  }
}

/**
 * Los datos del periodo a registrar no se sostienen entre sí: un importe negativo, un periodo que
 * termina antes de empezar, un cobro de Stripe sin factura o uno manual sin folio ni autor.
 *
 * Vive en el caso de uso y no sólo en el DTO del endpoint porque el adaptador de Stripe también
 * lo invoca, y por ahí no pasa ninguna validación de `class-validator`. Es la última frontera
 * antes de escribir dinero en la base.
 */
export class InvalidBillingRegistrationException extends BadRequestException {
  constructor(reason: string) {
    super(`No se puede registrar el periodo facturado: ${reason}`);
  }
}

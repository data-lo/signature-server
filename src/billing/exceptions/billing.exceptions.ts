import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
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
 * El paquete de documentos pedido no se le puede vender a esta cuenta.
 *
 * **Un solo error para cinco causas distintas, a propósito**: que el precio no exista, que esté
 * dado de baja, que no sea un paquete de documentos, que no sea de pago único, o que sea de otro
 * plan. Distinguirlas en la respuesta le diría a quien manipula el `catalogPriceId` exactamente
 * qué probar a continuación —"existe pero es de otro plan" es media respuesta—, y para el
 * usuario legítimo las cinco significan lo mismo: esa oferta no está en su lista. El motivo real
 * queda en el log.
 *
 * 404 y no 403: desde la cuenta que pregunta, un paquete de otro plan sencillamente no forma
 * parte de su catálogo.
 */
export class DocumentCreditOfferNotAvailableException extends NotFoundException {
  constructor() {
    super('El paquete de documentos seleccionado no está disponible.');
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
 * Se pidió cancelar cuando no hay ninguna suscripción de pago que dar de baja: la cuenta no tiene
 * perfil, su perfil no está `ACTIVE`, o está `ACTIVE` sin `stripe_subscription_id`.
 *
 * **Los tres casos responden lo mismo a propósito.** Desde fuera son la misma situación —"no hay
 * nada que cancelar"— y distinguirlos sólo serviría para sondear qué tiene contratada una
 * organización ajena. El detalle que sí hace falta para depurar viaja en `cause`, que se queda en
 * el log del servidor.
 *
 * El tercer caso no es teórico: un perfil en plan gratuito está en `FREE`, pero uno que se
 * quedó a medio contratar puede estar `ACTIVE` por una corrección manual sin que exista la
 * suscripción en el proveedor. Pedirle a Stripe que actualice `undefined` daría un 400 suyo, y el
 * usuario vería un error del proveedor donde lo cierto es que no hay nada que cancelar.
 *
 * 409 y no 404: la petición está bien formada y el recurso existe; lo que choca es el estado
 * actual, y el frontend necesita distinguirlo para redibujar la tarjeta en vez de tratarlo como
 * una ruta rota.
 */
export class NoActiveSubscriptionToCancelException extends ConflictException {
  constructor(reason: string) {
    super('No tienes una suscripción activa que cancelar.');
    this.cause = reason;
  }
}

/**
 * La baja ya estaba programada y se volvió a pedir.
 *
 * Se corta ANTES de hablar con Stripe. Repetir la llamada sería inofensivo para el proveedor
 * —`cancel_at_period_end: true` sobre algo que ya lo tiene es idempotente— pero gastaría una
 * llamada de red por cada doble clic y, sobre todo, dejaría al frontend sin forma de distinguir
 * "acabo de cancelar" de "ya estaba cancelado". El 409 es lo que le permite refrescar y mostrar
 * la fecha de término en vez de un segundo mensaje de éxito.
 */
export class SubscriptionCancellationAlreadyScheduledException extends ConflictException {
  constructor() {
    super(
      'La cancelación de tu suscripción ya está programada para el final del periodo vigente.',
    );
  }
}

/**
 * Se pidió reanudar una suscripción que no tiene ninguna baja programada.
 *
 * Se corta antes de hablar con Stripe, por el mismo motivo que su gemela de cancelación: mandar
 * `cancel_at_period_end: false` sobre algo que ya renueva sería inofensivo allá, pero dejaría al
 * frontend sin distinguir "acabo de reanudar" de "no había nada que reanudar" — y con ello, sin
 * saber si el botón que acaba de pulsar el usuario hizo algo.
 */
export class NoScheduledCancellationToResumeException extends ConflictException {
  constructor() {
    super('Tu suscripción no tiene ninguna cancelación programada.');
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

/**
 * La acción que se pidió no está incluida en el plan de la cuenta activa.
 *
 * Es la mitad que de verdad autoriza: `GET /payments/billing-state` le dice al frontend qué
 * dibujar, pero un cliente puede mandar la petición sin haber pedido nunca esa respuesta —o
 * habiéndola pedido con otra cuenta activa—, así que la comprobación se repite acá, contra el
 * mismo mapa de beneficios, en el momento de ejecutar.
 *
 * 403 y no 404: el recurso existe y la petición está bien formada; lo que falta es el derecho a
 * usarlo. El frontend lo necesita distinto de un 402 para mandar al usuario a MEJORAR SU PLAN en
 * vez de a comprar saldo, que son dos caminos comerciales distintos.
 *
 * El mensaje no dice qué plan hace falta: eso depende de la tabla comercial vigente y anunciarlo
 * desde el error obligaría a mantener la lista en dos sitios. La pantalla de planes ya la tiene.
 *
 * **`message` es la excepción a esa regla, no su abandono.** Hay flujos donde producto redactó la
 * negativa palabra por palabra —crear una organización responde "No disponible en plan Free.
 * Contrata un plan para crear una organización."— y esa copia tiene que salir tal cual del backend,
 * porque el frontend la muestra sin reescribirla. Se pasa por parámetro en vez de tener una
 * excepción por acción: el status, la causa que se registra y el camino comercial son los mismos, y
 * lo único que cambia es la frase.
 */
export class PlanActionNotIncludedException extends ForbiddenException {
  /**
   * @param action Acción del plan que se pidió, con el mismo símbolo que viaja al frontend.
   * @param planType Plan resuelto de la cuenta activa; `null` cuando no tiene perfil.
   * @param message Copia específica del flujo. Se omite salvo que producto la haya redactado.
   */
  constructor(action: string, planType: string | null, message?: string) {
    super(message ?? 'Tu plan actual no incluye esta funcionalidad.');
    this.cause = `La acción ${action} no está habilitada para el plan ${planType ?? '(sin plan)'}.`;
  }
}

/**
 * El plan incluye la acción, pero la cuenta no tiene saldo de documentos para ejecutarla.
 *
 * **Es un caso distinto de `PlanActionNotIncludedException` y por eso es otro status.** Ahí falta
 * plan, acá falta saldo: quien recibe esto ya compró lo correcto y sólo tiene que recargar.
 * Colapsar los dos en un 403 mandaría a mejorar de plan a quien ya está en el que necesita.
 *
 * 402 Payment Required, que es exactamente lo que ocurre. No lo cubre ninguna excepción de Nest,
 * así que se construye a mano sobre `HttpException`.
 *
 * **La lanzan los dos lados del saldo y a propósito con el mismo status**: la comprobación previa
 * de `AssertPlanActionUseCase` —que mira `creditsAvailable` para que la pantalla no ofrezca lo
 * que no se puede— y el descuento real de `ConsumeDocumentCreditUseCase`, que es el único que
 * decide de verdad porque corre dentro de la transacción del alta. Entre una y otra el saldo
 * puede haberse agotado en otra pestaña, así que el segundo NO es redundante; para quien recibe
 * la respuesta, las dos son "no te quedan documentos" y merecen el mismo camino en el frontend.
 *
 * `detail` existe para el segundo caso: en el descuento no siempre hay un `available` que valga
 * la pena publicar —una cuenta sin perfil de facturación no tiene ni lotes— y lo accionable para
 * depurar es qué perfil se miró. Viaja en `cause`, que se queda en el log del servidor: hacia
 * fuera la respuesta es idéntica en los dos casos, porque distinguirlos sólo expondría cómo está
 * montada la facturación por dentro.
 */
export class InsufficientDocumentCreditsException extends HttpException {
  constructor(required: number, available: number, detail?: string) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        message:
          'No tienes documentos disponibles. Compra más o espera a tu próximo periodo.',
        error: 'Payment Required',
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
    this.cause =
      `Se requieren ${required} documento(s) y hay ${available} disponible(s).` +
      (detail ? ` ${detail}` : '');
  }
}

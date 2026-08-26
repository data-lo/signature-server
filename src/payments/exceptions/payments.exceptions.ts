import {
  BadGatewayException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

/**
 * El proveedor de pagos no respondió, o respondió algo que rompe su contrato.
 *
 * 502 y no 500: el fallo es de un sistema de terceros, no nuestro. La distinción importa para
 * quien mire los logs y para el frontend, que puede ofrecer reintentar en lugar de dar por
 * perdida la operación.
 */
export class PaymentGatewayUnavailableException extends BadGatewayException {
  constructor() {
    super(
      'El proveedor de pagos no está disponible en este momento. Inténtalo de nuevo en unos minutos.',
    );
  }
}

/**
 * Stripe rechazó nuestras credenciales: la llave no vale, fue revocada, es de otra cuenta, o es
 * una *restricted key* sin permiso de lectura sobre productos y precios.
 *
 * **500 y no 502, aunque el error lo devuelva Stripe.** La distinción no es cosmética: un 502
 * dice "el proveedor está caído, reintenta en un rato" y manda a quien lo lea a mirar el estado
 * de Stripe, cuando lo que pasa es que *nuestro* despliegue está mal configurado y no se va a
 * arreglar solo por esperar. Confundir las dos cosas fue exactamente lo que hizo que este fallo
 * se reportara como "no cargan los planes", sin causa, en vez de "falta revisar la llave".
 *
 * El mensaje no menciona a Stripe: al usuario final no le sirve saber de quién es la culpa, y el
 * detalle accionable queda en el log del servidor, que es donde se puede actuar.
 */
export class PaymentGatewayMisconfiguredException extends InternalServerErrorException {
  constructor() {
    super(
      'El servicio de pagos no está configurado correctamente. Avísale al equipo de soporte.',
    );
  }
}

/**
 * Se pidió una sesión de Checkout para un precio que no está en el catálogo activo.
 *
 * Es la guarda que impide cobrar por algo que no ofrecemos: sin ella, cualquiera con sesión
 * podría mandar un `price_...` arbitrario —de otro producto, de otra cuenta de Stripe, o uno
 * archivado con un importe viejo— y obtener una URL de pago válida.
 */
export class PaymentServiceNotAvailableException extends NotFoundException {
  constructor() {
    super('El servicio seleccionado no está disponible.');
  }
}

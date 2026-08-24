import { BadGatewayException, NotFoundException } from '@nestjs/common';

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

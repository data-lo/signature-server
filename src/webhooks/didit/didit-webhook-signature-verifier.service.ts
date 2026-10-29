import { createHmac, timingSafeEqual } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Ventana de tolerancia para `x-timestamp`. Sin ella, una entrega legítima capturada por un
 * tercero podría reenviarse indefinidamente: la firma sigue siendo válida para siempre porque
 * el cuerpo no cambia. Cinco minutos es el margen que Didit documenta y absorbe el desfase
 * normal de reloj entre servidores.
 */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/**
 * Verifica el HMAC-SHA256 con el que Didit firma cada webhook.
 *
 * Es deliberadamente ciego al contenido: no sabe qué es una verificación de identidad ni qué
 * significa `status: Approved`. Sólo responde "esto lo mandó Didit" o "no".
 */
@Injectable()
export class DiditWebhookSignatureVerifierService {
  private readonly logger = new Logger(
    DiditWebhookSignatureVerifierService.name,
  );

  constructor(private readonly configService: ConfigService) {}

  /**
   * @param rawBody Cuerpo **crudo** de la petición. Tiene que ser el mismo array de bytes que
   *   Didit firmó: re-serializar el JSON parseado cambia espacios y orden de llaves y el HMAC
   *   deja de coincidir.
   */
  verify(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    timestamp: string | undefined,
  ): boolean {
    const secret = this.configService.get<string>('DIDIT_WEBHOOK_SECRET_KEY');

    if (!secret) {
      // Config faltante, no un ataque: se rechaza igual (no podemos confiar en nada sin
      // secreto) pero se registra como error para que no pase inadvertido en el despliegue.
      this.logger.error(
        'DIDIT_WEBHOOK_SECRET_KEY no está configurado: no es posible verificar webhooks de Didit.',
      );
      return false;
    }

    if (!rawBody || !signature || !timestamp) {
      return false;
    }

    if (!this.isTimestampFresh(timestamp)) {
      return false;
    }

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

    return this.matches(expected, signature);
  }

  private isTimestampFresh(timestamp: string): boolean {
    const sentAt = Number(timestamp);

    if (!Number.isFinite(sentAt)) {
      return false;
    }

    const nowInSeconds = Math.floor(Date.now() / 1000);
    return Math.abs(nowInSeconds - sentAt) <= TIMESTAMP_TOLERANCE_SECONDS;
  }

  /**
   * Comparación en tiempo constante: un `===` normal corta en el primer byte distinto, y ese
   * diferencial de tiempo, medido sobre muchos intentos, permite reconstruir la firma byte a
   * byte. `timingSafeEqual` exige longitudes iguales, de ahí el chequeo previo.
   */
  private matches(expected: string, received: string): boolean {
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const receivedBuffer = Buffer.from(received, 'utf8');

    if (expectedBuffer.length !== receivedBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, receivedBuffer);
  }
}

import { createHmac, timingSafeEqual } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Ventana de tolerancia para `x-timestamp`, la misma que en los webhooks de Didit: absorbe el
 * desfase normal de reloj entre servidores y acota el reenvío de una entrega capturada.
 */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/**
 * Verifica el HMAC-SHA256 con el que el indexador firma cada webhook.
 *
 * Es deliberadamente ciego al contenido: sólo responde "esto lo mandó el indexador" o "no".
 */
@Injectable()
export class IndexerWebhookSignatureVerifierService {
  private readonly logger = new Logger(
    IndexerWebhookSignatureVerifierService.name,
  );

  constructor(private readonly configService: ConfigService) {}

  /**
   * Comprueba la firma y la vigencia de una entrega.
   *
   * @param rawBody - Cuerpo **crudo** de la petición: re-serializar el JSON parseado cambia espacios
   *   y orden de llaves, y el HMAC dejaría de coincidir.
   * @param signature - Cabecera `x-signature`, en hexadecimal.
   * @param timestamp - Cabecera `x-timestamp`, en segundos Unix.
   * @returns `true` sólo si hay secreto configurado, la firma coincide y el timestamp está vigente.
   *
   * @example
   * ```ts
   * verifier.verify(request.rawBody, 'a1b2...', '1793404800'); // false si la firma no coincide
   * ```
   */
  verify(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    timestamp: string | undefined,
  ): boolean {
    const secret = this.configService.get<string>('INDEXER_WEBHOOK_SECRET');

    if (!secret) {
      // Config faltante, no un ataque: se rechaza igual (no podemos confiar en nada sin
      // secreto) pero se registra como error para que no pase inadvertido en el despliegue.
      this.logger.error(
        'INDEXER_WEBHOOK_SECRET no está configurado: no es posible verificar webhooks del indexador.',
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

  /** Comparación en tiempo constante; `timingSafeEqual` exige longitudes iguales. */
  private matches(expected: string, received: string): boolean {
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const receivedBuffer = Buffer.from(received, 'utf8');

    if (expectedBuffer.length !== receivedBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, receivedBuffer);
  }
}

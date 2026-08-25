import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

/**
 * Ya hay una captura reclamada desde un teléfono y todavía en curso.
 *
 * 409 en vez de sustituirla en silencio: si el usuario está dibujando su firma en el celular y
 * la PC vuelve a pedir un QR (un doble clic, una pestaña recargada), rotar el token dejaría
 * muerto el envío del teléfono justo antes de terminar. Se le pide que cancele explícitamente.
 */
export class SignatureCaptureSessionInProgressException extends ConflictException {
  constructor() {
    super(
      'Ya tienes una captura de firma en curso desde tu teléfono. Termínala o cancélala antes de iniciar otra.',
    );
  }
}

/**
 * El token del QR no corresponde a ninguna sesión utilizable: nunca existió, ya se canjeó, se
 * canceló o venció.
 *
 * **Todos esos casos comparten mensaje y código a propósito.** Distinguirlos convertiría el
 * endpoint en un oráculo: con respuestas distintas para "no existe" y "ya se usó", un atacante
 * podría ir confirmando qué tokens fueron reales. Al portador legítimo, además, la distinción
 * no le sirve de nada: en los cuatro casos lo que tiene que hacer es generar otro QR.
 */
export class InvalidSignatureCaptureTokenException extends NotFoundException {
  constructor() {
    super(
      'El código QR ya no es válido. Genera uno nuevo desde tu computadora e inténtalo otra vez.',
    );
  }
}

/**
 * La sesión existe pero pertenece a otro usuario.
 *
 * 403 y no 404: quien llega acá está autenticado y el recurso existe; lo que falta es que sea
 * suyo. Es la barrera que impide que un QR fotografiado por un tercero le sirva para registrar
 * una firma en la cuenta ajena, incluso teniendo el token en la mano.
 */
export class SignatureCaptureSessionForbiddenException extends ForbiddenException {
  constructor() {
    super('Esta captura de firma pertenece a otro usuario.');
  }
}

/**
 * Se intentó operar sobre una sesión que ya no lo admite: completada, cancelada, vencida, o
 * todavía sin reclamar desde el teléfono. El detalle lo arma quien lanza, que es el único que
 * sabe qué le faltaba.
 */
export class SignatureCaptureSessionNotUsableException extends ConflictException {
  constructor(detail: string) {
    super(detail);
  }
}

/**
 * El archivo recibido no es un PNG.
 *
 * Se comprueba el contenido y no sólo el `Content-Type`, que lo escribe el cliente y por tanto
 * no prueba nada: un `.exe` renombrado llega con la cabecera que su autor quiera.
 */
export class InvalidSignatureImageException extends BadRequestException {
  constructor(detail: string) {
    super(detail);
  }
}

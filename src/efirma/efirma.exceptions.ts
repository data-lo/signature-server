import {
  BadGatewayException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

export class CertificadoInvalidoException extends UnprocessableEntityException {
  constructor(detalle?: string) {
    super(
      `El certificado no encadena a una AC del SAT valida${detalle ? `${detalle}` : ''}`,
    );
  }
}

export class CertificadoExpiradoException extends UnprocessableEntityException {
  constructor(vigenciaHasta: Date) {
    super(
      `El certificado (.cer) expiró su vigencia el ${vigenciaHasta.toISOString()}`,
    );
  }
}

export class LLavePrivadaInvalidException extends UnprocessableEntityException {
  constructor(dettalle?: string) {
    super(
      `No fue posible descifrar la llave privada (.key). verifica la constraseña.${
        dettalle ? `Detalle: ${dettalle}` : ''
      }`,
    );
  }
}

export class LLaveNoCorrespondeCertificadoException extends UnprocessableEntityException {
  constructor() {
    super(
      'La llave privada (.key) no corresponde al certificado proporcionado',
    );
  }
}

export class CadenaConfianzaInvalidaException extends UnprocessableEntityException {
  constructor(detalle?: string) {
    super(
      `El certificado no encadena a una AC del SAT valida${detalle ? `${detalle}` : ''}`,
    );
  }
}

/**
 * El SAT reporta el certificado como revocado. Es un 422 —el firmante tiene que usar otra e.firma—,
 * no un `Error` plano, que Nest convertía en un 500 genérico sin decirle qué pasó.
 */
export class CertificadoRevocadoException extends UnprocessableEntityException {
  constructor(
    public readonly revokedDate?: Date,
    public readonly reason?: string,
  ) {
    super(
      `El certificado fue revocado por el SAT${revokedDate ? ` el ${revokedDate.toISOString()}` : ''}${
        reason ? ` (razón: ${reason})` : ''
      }`,
    );
    this.name = 'CertificadoRevocadoException';
  }
}

/**
 * El respondedor OCSP del SAT no contestó (caído, lento o inalcanzable).
 *
 * **503 y no un `Error` plano**, que Nest convertía en un 500 genérico: quien firma necesita
 * saber que el problema es del SAT y que reintentar más tarde tiene sentido, no leer "error
 * interno del servidor" sobre algo que no falló de nuestro lado.
 *
 * El detalle técnico se registra en el log, no se devuelve: al firmante no le sirve el mensaje de
 * la librería de OCSP, y puede exponer la topología del servicio.
 */
export class OCSPNotAvailableException extends ServiceUnavailableException {
  constructor() {
    super(
      'No fue posible validar tu certificado ante el SAT porque su servicio no respondió. ' +
        'Vuelve a intentarlo en unos minutos.',
    );
  }
}

/**
 * El SAT respondió la consulta OCSP, pero la respuesta no sirve como evidencia de revocación: no
 * trae la respuesta firmada (`rawResponse`) o reporta un estado que no es `good`, `unknown` ni
 * `revoked`.
 *
 * Se separa de `OCSPNotAvailableException` porque no es una caída del SAT: repetir la consulta en
 * unos minutos no garantiza otra respuesta, y sellar con ella dejaría una constancia sin la prueba
 * que debe sostener. 502: el problema está en lo que contestó el tercero, no en la petición.
 *
 * El detalle técnico va al log; el mensaje no incluye datos del certificado.
 */
export class OCSPInvalidResponseException extends BadGatewayException {
  constructor(readonly reason: string) {
    super(
      'El SAT respondió la validación de tu certificado con una respuesta que no se puede usar como evidencia.',
    );
    this.name = 'OCSPInvalidResponseException';
  }
}

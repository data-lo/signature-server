import {
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

export class CertificadoRevocadoException extends Error {
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
 * El respondedor OCSP del SAT no contestó: caído, lento o inalcanzable.
 *
 * **503 y no un `Error` plano**, que Nest convertía en un 500 genérico: quien firma necesita saber
 * que el problema es del SAT y que reintentar más tarde tiene sentido, no leer "error interno del
 * servidor" sobre algo que no falló de nuestro lado.
 *
 * El detalle técnico queda en el log y no se devuelve: al firmante no le sirve, y puede exponer la
 * topología del servicio.
 */
export class OCSPNotAvailableException extends ServiceUnavailableException {
  constructor() {
    super(
      'No fue posible validar tu certificado ante el SAT porque su servicio no respondió. ' +
        'Vuelve a intentarlo en unos minutos.',
    );
  }
}

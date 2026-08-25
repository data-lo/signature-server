import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';

/** Falta `DIDIT_API_KEY` o `DIDIT_WORKFLOW_ID` en el entorno. */
export class DiditConfigurationException extends InternalServerErrorException {
  constructor() {
    super('La verificación de identidad no está configurada correctamente.');
  }
}

/** Didit no respondió dentro del tiempo configurado. */
export class DiditTimeoutException extends GatewayTimeoutException {
  constructor() {
    super('El proveedor de verificación tardó demasiado en responder.');
  }
}

/** No se pudo abrir una conexión con Didit. */
export class DiditUnavailableException extends ServiceUnavailableException {
  constructor() {
    super(
      'El proveedor de verificación no está disponible temporalmente. Inténtalo de nuevo en unos minutos.',
    );
  }
}

/** Didit contestó un error HTTP, o un cuerpo que no respeta su contrato. */
export class DiditResponseException extends BadGatewayException {
  constructor() {
    super('El proveedor de verificación devolvió una respuesta no válida.');
  }
}

/** El usuario ya tiene una identidad aprobada: no tiene sentido reverificar. */
export class IdentityAlreadyVerifiedException extends ConflictException {
  constructor() {
    super('Tu identidad ya fue verificada.');
  }
}

/**
 * El usuario intentó una operación que su `signingCredentialStatus` todavía no habilita
 * (subir su firma PNG sin identidad aprobada, por ejemplo). 403 y no 401: está autenticado, lo
 * que le falta es el requisito, no la sesión.
 *
 * El detalle lo arma quien lanza, a partir del estado concreto: decirle "no puedes subir tu
 * firma" sin explicar que su verificación sigue en revisión lo deja sin saber qué hacer.
 */
export class SigningCredentialNotReadyException extends ForbiddenException {
  constructor(detail: string) {
    super(detail);
  }
}

/**
 * Se intentó mover `signingCredentialStatus` a un estado al que no se puede llegar desde el
 * actual. Es un error de programación o una carrera, no algo que el usuario pueda corregir:
 * se responde 409 y se registra, en vez de escribir un estado inconsistente.
 */
export class InvalidSigningCredentialTransitionException extends ConflictException {
  constructor(from: string, to: string) {
    super(`No se puede pasar la credencial de firma de ${from} a ${to}.`);
  }
}

/** El usuario agotó los intentos de verificación permitidos. */
export class MaxIdentityVerificationAttemptsExceededException extends ForbiddenException {
  constructor(maxAttempts: number) {
    super(
      `Agotaste los ${maxAttempts} intentos de verificación de identidad disponibles. Contacta a soporte para desbloquear tu cuenta.`,
    );
  }
}

/**
 * La verificación está bloqueada de forma definitiva (bloqueo administrativo o error final):
 * el usuario no puede abrir una sesión nueva por su cuenta.
 */
export class IdentityVerificationBlockedException extends ForbiddenException {
  constructor() {
    super(
      'Tu verificación de identidad está bloqueada. Contacta a soporte para continuar.',
    );
  }
}

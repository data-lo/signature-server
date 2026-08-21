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
 * El usuario intentó una operación que exige identidad aprobada (subir su firma PNG) sin
 * tenerla. 403 y no 401: está autenticado, lo que le falta es el requisito, no la sesión.
 */
export class IdentityNotApprovedException extends ForbiddenException {
  constructor(detail: string) {
    super(detail);
  }
}

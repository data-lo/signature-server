import {
  BadGatewayException,
  ConflictException,
  GatewayTimeoutException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';

/** El servidor no tiene la configuración necesaria para llamar al proveedor. */
export class SealProviderConfigurationException extends InternalServerErrorException {
  constructor() {
    super('El servicio de sellado no está configurado correctamente.');
  }
}

/** El proveedor no respondió dentro del tiempo configurado. */
export class SealProviderTimeoutException extends GatewayTimeoutException {
  constructor() {
    super('El servicio de sellado tardó demasiado en responder.');
  }
}

/** No se pudo abrir una conexión con el proveedor de sellado. */
export class SealProviderUnavailableException extends ServiceUnavailableException {
  constructor() {
    super('El servicio de sellado no está disponible temporalmente.');
  }
}

/** El proveedor contestó un error HTTP o un cuerpo que no respeta su contrato. */
export class SealProviderResponseException extends BadGatewayException {
  constructor() {
    super('El servicio de sellado devolvió una respuesta no válida.');
  }
}

/** Ya existe evidencia de sellado para el documento. */
export class DocumentAlreadySealedException extends ConflictException {
  constructor() {
    super('El documento ya cuenta con sellos generados.');
  }
}

/** No se pudo persistir la evidencia generada por el proveedor. */
export class SealPersistenceException extends InternalServerErrorException {
  constructor() {
    super('No fue posible guardar la evidencia de sellado del documento.');
  }
}

import {
  BadGatewayException,
  ConflictException,
  GatewayTimeoutException,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnprocessableEntityException,
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

/**
 * Falta un dato obligatorio para armar el envío de firma simple a Seal Service.
 *
 * El mensaje nombra QUÉ falta y a QUIÉN, pero identifica al firmante por el id de su fila de
 * colaborador —nunca por su correo, su nombre o su CURP—: este texto termina en logs y en
 * respuestas HTTP, y ninguno de los dos es lugar para datos personales. Con ese id, quien opere
 * el incidente llega al firmante consultando la base.
 */
export class IncompleteSimpleSignatureDataException extends UnprocessableEntityException {
  constructor(missingData: string, collaboratorId: string) {
    super(
      `No se puede enviar la firma simple a Seal Service: falta ${missingData} del firmante ${collaboratorId}.`,
    );
  }
}

import {
  BadGatewayException,
  ConflictException,
  GatewayTimeoutException,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

import type { SealingFailure } from '../interfaces/sealing-failure.interface';

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

/**
 * El proveedor contestó un error HTTP o un cuerpo que no respeta su contrato.
 *
 * `upstreamStatus` es el estado HTTP que devolvió Seal Service (`null` si respondió `200` con un
 * cuerpo incompleto): el worker distingue con él un `5xx`, que se reintenta, de un `4xx`, que no.
 */
export class SealProviderResponseException extends BadGatewayException {
  constructor(readonly upstreamStatus: number | null = null) {
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
 * Falta evidencia de un firmante FIEL para congelar el payload de sellado avanzado: hoy, la
 * respuesta OCSP que el SAT no devolvió al firmar.
 *
 * El mensaje nombra QUÉ falta y a QUIÉN, pero identifica al firmante por el id de su fila de
 * colaborador —nunca por su correo, su nombre, su RFC o su CURP—: este texto termina en logs y en
 * `document_sealing_jobs.last_error_message`, y ninguno de los dos es lugar para datos personales.
 */
export class IncompleteAdvancedSignatureEvidenceException extends UnprocessableEntityException {
  /**
   * @param missingData - Qué falta, por ejemplo `la evidencia OCSP`.
   * @param collaboratorId - Fila de colaborador del firmante; nunca su RFC ni su nombre.
   */
  constructor(missingData: string, collaboratorId: string) {
    super(
      `No se puede congelar el sellado avanzado: falta ${missingData} del firmante ${collaboratorId}.`,
    );
  }
}

/**
 * Falta un dato obligatorio para armar el envío de firma simple a Seal Service.
 *
 * Mismo criterio de privacidad que `IncompleteAdvancedSignatureEvidenceException`: identifica al
 * firmante por el id de su fila de colaborador.
 */
export class IncompleteSimpleSignatureDataException extends UnprocessableEntityException {
  constructor(missingData: string, collaboratorId: string) {
    super(
      `No se puede enviar la firma simple a Seal Service: falta ${missingData} del firmante ${collaboratorId}.`,
    );
  }
}

/**
 * Seal Service ya está emitiendo la evidencia de este documento con la misma clave (respondió
 * `202`). No es un fallo: el siguiente intento recibirá la evidencia sin otra emisión.
 */
export class SealOperationInProgressException extends ConflictException {
  constructor() {
    super(
      'El sellado del documento sigue en proceso en el servicio de sellado.',
    );
  }
}

/**
 * La clave del documento ya se usó con otro payload: lo que se quiere sellar cambió después del
 * primer envío. No se reintenta; requiere revisión.
 */
export class SealIdempotencyConflictException extends ConflictException {
  constructor() {
    super(
      'El contenido a sellar cambió después del primer envío: el servicio de sellado lo rechaza como conflicto.',
    );
  }
}

/**
 * Seal Service no sabe si el PSC emitió la evidencia (timeout, 5xx o respuesta perdida) y no la
 * volverá a emitir hasta conciliarla. Repetir el envío no cambia la respuesta.
 */
export class SealReconciliationRequiredException extends ConflictException {
  constructor(readonly reasonCode: string | null) {
    super(
      'El servicio de sellado requiere conciliación antes de volver a emitir la evidencia de este documento.',
    );
  }
}

/**
 * Un intento de `ProcessDocumentSealingJobUseCase` falló. Lleva el fallo ya clasificado
 * (`SealingFailure`) para que el worker decida, sin interpretar mensajes, si reprograma el trabajo,
 * lo manda a conciliación o lo da por muerto. La causa original queda en `cause`, sólo para logs.
 */
export class DocumentSealingJobFailedException extends Error {
  constructor(
    readonly failure: SealingFailure,
    options?: { cause?: unknown },
  ) {
    super(
      `El trabajo de sellado falló en ${failure.phase}: ${failure.code}.`,
      options,
    );
    this.name = 'DocumentSealingJobFailedException';
  }
}

/**
 * El trabajo ya no pertenece a quien lo está procesando: no está en `PROCESSING`, su
 * `lease_token` cambió o el reclamo venció. Quien lo recibe deja de escribir; no es un fallo del
 * trabajo y no se registra en él, porque ahora lo tiene otro worker.
 */
export class SealingJobLeaseLostException extends Error {
  constructor(readonly jobId: string) {
    super(`El trabajo de sellado ${jobId} ya no pertenece a este worker.`);
    this.name = 'SealingJobLeaseLostException';
  }
}

/**
 * No se pudo regenerar o publicar el PDF final con la constancia (MinIO o la generación de la
 * hoja). La constancia ya está guardada: repetir sólo vuelve a esta fase, sin otro sello.
 */
export class SealedEvidencePdfUpdateException extends InternalServerErrorException {
  constructor() {
    super('No fue posible actualizar la hoja de evidencia del documento.');
  }
}

/**
 * El PDF firmado de `signed_documents` ya no produce el `signedHash` registrado. No se le anexa
 * nada: la hoja certificaría un archivo distinto del que se firmó.
 */
export class SignedPdfIntegrityException extends ConflictException {
  constructor() {
    super(
      'El PDF firmado almacenado no coincide con el hash registrado del documento.',
    );
  }
}

/**
 * El payload congelado de un trabajo no coincide con lo que el trabajo registró: sus bytes no dan
 * `request_hash`, es de otro documento o de otro contrato. No se envía: sellaría otro contenido.
 */
export class SealingRequestSnapshotMismatchException extends ConflictException {
  constructor() {
    super(
      'El payload de sellado congelado no coincide con el registrado en el trabajo.',
    );
  }
}

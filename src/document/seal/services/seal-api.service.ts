import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { SealDocumentDto } from '../dto/seal-document.dto';
import { SimpleSignatureDTO } from '../dto/simple-signature.dto';
import {
  SealIdempotencyConflictException,
  SealOperationInProgressException,
  SealProviderConfigurationException,
  SealProviderResponseException,
  SealProviderTimeoutException,
  SealProviderUnavailableException,
  SealReconciliationRequiredException,
} from '../exceptions/seal.exceptions';
import { SealDocumentResponse } from '../interfaces/seal-document-response.interface';
import {
  SEAL_OPERATION_ERROR_CODE_ENUM,
  SealOperationLookup,
} from '../interfaces/seal-operation-response.interface';
import {
  buildSealIdempotencyKey,
  fingerprintAdvancedSealRequest,
  fingerprintSimpleSealRequest,
  SealRequestFingerprint,
} from '../utils/seal-request-fingerprint.util';

/** Tiempo máximo de espera de Seal Service: emite dos sellos (TSA + NOM-151) contra un PSC externo. */
const SEAL_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Ruta del envío de firmas simples, hermana de `/seal/signature` (firma avanzada).
 *
 * Va aparte porque lo que se manda no tiene nada que ver: `/seal/signature` transporta firmas
 * criptográficas con su certificado del SAT, y esto transporta la identidad del firmante, la
 * evidencia de su OTP y la imagen de su rúbrica.
 */
const SIMPLE_SIGNATURE_PATH = '/seal/simple-signature';

/** Ruta del sellado de firmas avanzadas. */
const ADVANCED_SIGNATURE_PATH = '/seal/signature';

/** Errores de dominio que ya salieron traducidos y no se vuelven a envolver. */
const DOMAIN_ERRORS = [
  SealOperationInProgressException,
  SealProviderResponseException,
];

/**
 * Cliente HTTP de Seal Service.
 *
 * **Idempotencia.** Cada sellado viaja con `Idempotency-Key: signature-server:document:<id>:v1` y
 * con el payload normalizado (firmas en orden estable; ver `seal-request-fingerprint.util.ts`).
 * Seal Service registra la clave antes de llamar al PSC, así que repetir el envío de un documento
 * —un timeout, un reinicio o un fallo al guardar la constancia— no emite otra constancia: devuelve
 * la evidencia que ya existe. Las respuestas del contrato se traducen así:
 * - `200`: evidencia, emitida ahora o repetida.
 * - `202`: otra petición la está emitiendo → `SealOperationInProgressException`.
 * - `409 IDEMPOTENCY_KEY_REUSED`: el payload cambió después del primer envío →
 *   `SealIdempotencyConflictException`.
 * - `409 SEAL_RECONCILIATION_REQUIRED`: resultado incierto ante el PSC →
 *   `SealReconciliationRequiredException`.
 */
@Injectable()
export class SealApiService {
  private readonly logger = new Logger(SealApiService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Envía a Seal Service el arreglo de firmas avanzadas del documento y devuelve su respuesta
   * (hash canónico + sello de tiempo + constancia NOM-151), que el caso de uso persiste.
   *
   * La autenticación es por API key en el header `x-api-key`, contra la variable `API_KEY` de
   * Seal Service. La clave sale de `SEAL_SERVICE_API_KEY` y nunca se registra en los logs.
   *
   * @param dto - Documento y firmas avanzadas.
   * @returns La evidencia.
   *
   * @throws {SealProviderConfigurationException} Si falta la configuración.
   * @throws {SealOperationInProgressException} Si otra petición la está emitiendo.
   * @throws {SealIdempotencyConflictException} Si el payload cambió después del primer envío.
   * @throws {SealReconciliationRequiredException} Si el resultado ante el PSC es incierto.
   * @throws {SealProviderResponseException} Si responde otro error o una respuesta incompleta.
   * @throws {SealProviderTimeoutException} Si no responde a tiempo; repetir es seguro.
   * @throws {SealProviderUnavailableException} Si no se puede conectar.
   *
   * @example
   * ```ts
   * const response = await sealApi.generateDocumentSeals(dto);
   * ```
   */
  async generateDocumentSeals(
    dto: SealDocumentDto,
  ): Promise<SealDocumentResponse> {
    const response = await this.postSeal(
      ADVANCED_SIGNATURE_PATH,
      fingerprintAdvancedSealRequest(dto),
      'las firmas avanzadas',
    );
    return this.assertUsableResponse(response, dto.documentId);
  }

  /**
   * Envía a Seal Service las firmas simples de un documento ya completo.
   *
   * El cuerpo lleva datos personales del firmante y su rúbrica en Base64, así que no se registra
   * ni un fragmento del DTO: ni al enviarlo ni al fallar. De la respuesta de error sólo se toma el
   * código HTTP y el código del contrato, porque un cuerpo de error suele venir con un eco de lo
   * que se le mandó.
   *
   * @param dto - Documento y evidencia de cada firmante simple.
   * @returns La evidencia, con la misma forma que la del sellado avanzado.
   *
   * @throws {SealProviderConfigurationException} Si falta la configuración.
   * @throws {SealOperationInProgressException} Si otra petición la está emitiendo.
   * @throws {SealIdempotencyConflictException} Si el payload cambió después del primer envío.
   * @throws {SealReconciliationRequiredException} Si el resultado ante el PSC es incierto.
   * @throws {SealProviderResponseException} Si responde otro error.
   * @throws {SealProviderTimeoutException} Si no responde a tiempo; repetir es seguro.
   * @throws {SealProviderUnavailableException} Si no se puede conectar.
   *
   * @example
   * ```ts
   * const response = await sealApi.sendSimpleSignatures(dto);
   * ```
   */
  async sendSimpleSignatures(
    dto: SimpleSignatureDTO,
  ): Promise<SealDocumentResponse> {
    return this.postSeal(
      SIMPLE_SIGNATURE_PATH,
      fingerprintSimpleSealRequest(dto),
      'las firmas simples',
    );
  }

  /**
   * Consulta en Seal Service el resultado del sellado de un documento, por su clave. Sirve para
   * recuperar una respuesta perdida sin volver a enviar el payload; la cadena canónica sólo se
   * obtiene repitiendo el sellado.
   *
   * @param documentId - Documento.
   * @returns El estado (`NOT_FOUND`, `PROCESSING`, `COMPLETED`, `FAILED` o
   *   `RECONCILIATION_REQUIRED`) y, si se completó, la evidencia.
   *
   * @throws {SealProviderConfigurationException} Si falta la configuración.
   * @throws {SealProviderResponseException} Si responde un error.
   * @throws {SealProviderTimeoutException} Si no responde a tiempo.
   * @throws {SealProviderUnavailableException} Si no se puede conectar.
   *
   * @example
   * ```ts
   * const { status, evidence } = await sealApi.getSealOperation(documentId);
   * ```
   */
  async getSealOperation(documentId: string): Promise<SealOperationLookup> {
    const { serviceUrl, apiKey } = this.resolveConfiguration();
    const idempotencyKey = buildSealIdempotencyKey(documentId);

    try {
      const httpResponse = await axios.get<SealOperationLookup>(
        `${serviceUrl}/seal/operations/${encodeURIComponent(idempotencyKey)}`,
        {
          headers: { 'x-api-key': apiKey },
          timeout: SEAL_REQUEST_TIMEOUT_MS,
          // 404 es una respuesta válida del contrato: `status: NOT_FOUND`.
          validateStatus: (status) => status === 200 || status === 404,
        },
      );
      return httpResponse.data;
    } catch (error) {
      throw this.translateTransportError(
        error,
        documentId,
        'la consulta de la operación',
      );
    }
  }

  /**
   * Envía un sellado con su clave de idempotencia y traduce la respuesta.
   *
   * @param path - Ruta en Seal Service.
   * @param fingerprint - Clave y payload normalizado.
   * @param description - Qué se envía, para los logs (sin datos del payload).
   * @returns La respuesta `200`.
   *
   * @throws {SealOperationInProgressException} Si responde `202`.
   * @throws {Error} Las excepciones de `translateTransportError`.
   *
   * @example
   * ```ts
   * return this.postSeal(SIMPLE_SIGNATURE_PATH, fingerprintSimpleSealRequest(dto), 'las firmas simples');
   * ```
   */
  private async postSeal<T extends { documentId: string }>(
    path: string,
    fingerprint: SealRequestFingerprint<T>,
    description: string,
  ): Promise<SealDocumentResponse> {
    const { serviceUrl, apiKey } = this.resolveConfiguration();
    const { documentId } = fingerprint.payload;

    try {
      const httpResponse = await axios.post<SealDocumentResponse>(
        `${serviceUrl}${path}`,
        fingerprint.payload,
        {
          headers: {
            'x-api-key': apiKey,
            'Idempotency-Key': fingerprint.idempotencyKey,
          },
          timeout: SEAL_REQUEST_TIMEOUT_MS,
          validateStatus: (status) => status === 200 || status === 202,
        },
      );

      if (httpResponse.status === 202) {
        this.logger.warn(
          `El sellado del documento ${documentId} sigue en proceso en Seal Service.`,
        );
        throw new SealOperationInProgressException();
      }

      if (httpResponse.headers?.['idempotent-replayed'] === 'true') {
        this.logger.log(
          `Seal Service devolvió la evidencia ya emitida del documento ${documentId}.`,
        );
      }
      return httpResponse.data;
    } catch (error) {
      if (DOMAIN_ERRORS.some((type) => error instanceof type)) {
        throw error;
      }
      throw this.translateTransportError(error, documentId, description);
    }
  }

  /**
   * Traduce un fallo de axios a la excepción de dominio que le corresponde, registrando sólo el
   * documento afectado, el código HTTP y el código del contrato.
   *
   * Devuelve la excepción en vez de lanzarla para que el llamador conserve el `throw` en su propio
   * flujo, y para que TypeScript no pierda de vista que ese camino termina.
   *
   * @param error - Lo que lanzó axios.
   * @param documentId - Documento afectado.
   * @param description - Qué se enviaba.
   * @returns La excepción de dominio.
   *
   * @example
   * ```ts
   * throw this.translateTransportError(error, documentId, 'las firmas simples');
   * ```
   */
  private translateTransportError(
    error: unknown,
    documentId: string,
    description: string,
  ): Error {
    if (!axios.isAxiosError(error)) {
      return error instanceof Error ? error : new Error(String(error));
    }

    const upstreamStatus = error.response?.status;

    if (upstreamStatus) {
      const body = error.response?.data as
        | { code?: string; reasonCode?: string | null }
        | undefined;

      if (upstreamStatus === 409) {
        if (
          body?.code === SEAL_OPERATION_ERROR_CODE_ENUM.IDEMPOTENCY_KEY_REUSED
        ) {
          this.logger.error(
            `Seal Service rechazó ${description} del documento ${documentId}: el payload cambió después del primer envío.`,
          );
          return new SealIdempotencyConflictException();
        }
        if (
          body?.code ===
          SEAL_OPERATION_ERROR_CODE_ENUM.SEAL_RECONCILIATION_REQUIRED
        ) {
          this.logger.error(
            `El sellado del documento ${documentId} requiere conciliación en Seal Service (${body.reasonCode ?? 'sin motivo'}).`,
          );
          return new SealReconciliationRequiredException(
            body.reasonCode ?? null,
          );
        }
      }

      this.logger.error(
        `Seal Service respondió HTTP ${upstreamStatus} al recibir ${description} del documento ${documentId}${body?.code ? ` (${body.code})` : ''}.`,
      );
      return new SealProviderResponseException();
    }

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      this.logger.error(
        `Timeout al enviar ${description} del documento ${documentId}; repetir con la misma clave es seguro.`,
      );
      return new SealProviderTimeoutException();
    }

    this.logger.error(
      `No se pudo conectar con el proveedor de sellado para enviar ${description} del documento ${documentId} (code=${error.code ?? 'unknown'}).`,
    );
    return new SealProviderUnavailableException();
  }

  /**
   * La configuración se resuelve al invocar, NO en el constructor: este provider vive en un módulo
   * que carga la aplicación entera, así que lanzar desde el constructor impedía arrancar el
   * servidor completo por una integración que la mayoría de los entornos de desarrollo no usa.
   */
  private resolveConfiguration(): { serviceUrl: string; apiKey: string } {
    const serviceUrl = this.configService.get<string>('SEAL_SERVICE_URL');
    const apiKey = this.configService.get<string>('SEAL_SERVICE_API_KEY');

    if (!serviceUrl || !apiKey) {
      this.logger.error(
        'Falta la configuración del proveedor de sellado (SEAL_SERVICE_URL / SEAL_SERVICE_API_KEY).',
      );
      throw new SealProviderConfigurationException();
    }

    return { serviceUrl: serviceUrl.replace(/\/+$/, ''), apiKey };
  }

  /**
   * Todo lo que se valida acá termina en una columna NOT NULL de `document_seals`: sin esta
   * comprobación, una respuesta incompleta del proveedor no falla en la frontera HTTP sino más
   * tarde, como un error de constraint de Postgres que no dice nada del origen real.
   *
   * También atrapa un cambio de contrato del proveedor (por ejemplo, que renombre `hashHex`).
   */
  private assertUsableResponse(
    response: SealDocumentResponse | undefined,
    documentId: string,
  ): SealDocumentResponse {
    const isUsable =
      Boolean(response) &&
      Boolean(response!.hashHex) &&
      Boolean(response!.canonicalString) &&
      Boolean(response!.timeStamp) &&
      Boolean(response!.nom151);

    if (!isUsable) {
      this.logger.error(
        `El proveedor devolvió una respuesta incompleta para el documento ${documentId}.`,
      );
      throw new SealProviderResponseException();
    }

    return response!;
  }
}

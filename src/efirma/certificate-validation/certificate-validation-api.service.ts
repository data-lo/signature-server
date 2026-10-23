import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { X509Certificate } from 'node:crypto';

import {
  CadenaConfianzaInvalidaException,
  CertificadoExpiradoException,
  CertificadoInvalidoException,
  CertificadoRevocadoException,
  CertificateValidationServiceUnavailableException,
  OCSPNotAvailableException,
} from '../efirma.exceptions';
import {
  CertificateRevocationStatus,
  CertificateValidationOptions,
  CertificateValidationResult,
} from '../interfaces/certificate-validation-result.interface';

/**
 * Tiempo máximo de espera de Certificate Validation Service.
 *
 * Holgado respecto al timeout OCSP del propio servicio (5 s por defecto): si el SAT tarda, se
 * prefiere recibir su `OCSP_SERVICE_UNAVAILABLE` —o el 200 sin evidencia— antes que cortar aquí y
 * no saber si la vigencia y la cadena llegaron a comprobarse.
 */
const CERTIFICATE_VALIDATION_TIMEOUT_MS = 10_000;

const VALIDATE_PATH = '/api/v1/certificates/validate';

/** Cuerpo de éxito de `POST /api/v1/certificates/validate`, tal como viaja en JSON. */
interface ValidateCertificateResponseBody {
  serialNumber: string;
  validity: { notBefore: string; notAfter: string; evaluatedAt: string };
  trustChain: { issuer: string; root: string };
  revocation: { status: CertificateRevocationStatus; checkedAt: string };
  ocspEvidence?: {
    status: 'good' | 'unknown';
    verifiedAt: string;
    ocspResponse: string;
    ocspUrl: string;
  };
}

/** Cuerpo de error estándar del servicio. */
interface ErrorResponseBody {
  statusCode?: number;
  code?: string;
}

@Injectable()
export class CertificateValidationApiService {
  private readonly logger = new Logger(CertificateValidationApiService.name);

  /**
   * @param configService - Fuente de `CERTIFICATE_VALIDATION_SERVICE_URL` y `_API_KEY`.
   * @returns El cliente listo para usarse.
   *
   * @example
   * ```ts
   * const client = new CertificateValidationApiService(configService);
   * ```
   */
  constructor(private readonly configService: ConfigService) {}

  /**
   * Valida un certificado de e.firma contra Certificate Validation Service.
   *
   * Sustituye a la validación local que hacía `EfirmaService` (vigencia y cadena de confianza) y a
   * la consulta OCSP de `OscpService`. Traduce el `code` de cada error a las excepciones que ya
   * existían en `efirma.exceptions.ts`, para que quien firma siga recibiendo los mismos estados y
   * mensajes que antes de la migración.
   *
   * Todo lo que no es un veredicto sobre el certificado —servicio caído, configuración ausente, API
   * Key rechazada, error interno o un `code` desconocido— termina en
   * `CertificateValidationServiceUnavailableException`, con el detalle sólo en el log. Ni el
   * certificado ni la API Key se registran.
   *
   * @param cerBuffer - Certificado (.cer) en DER o PEM.
   * @param options - Fecha de referencia para la vigencia y tolerancia a que el SAT no responda.
   * @returns El resultado de la validación; sin `ocspEvidence` si el SAT no respondió y
   * `allowUnverifiedRevocation` lo permitía.
   *
   * @throws {CertificadoInvalidoException} Si el contenido no es un certificado (`INVALID_CERTIFICATE`).
   * @throws {CertificadoExpiradoException} Si está vencido o aún no vigente
   * (`CERTIFICATE_EXPIRED` / `CERTIFICATE_NOT_YET_VALID`).
   * @throws {CadenaConfianzaInvalidaException} Si no encadena al SAT (`INVALID_TRUST_CHAIN`).
   * @throws {CertificadoRevocadoException} Si el SAT lo reporta revocado (`CERTIFICATE_REVOKED`).
   * @throws {OCSPNotAvailableException} Si el SAT no respondió y no se permitió seguir
   * (`OCSP_SERVICE_UNAVAILABLE`).
   * @throws {CertificateValidationServiceUnavailableException} Ante cualquier otro fallo.
   *
   * @example
   * ```ts
   * const result = await client.validateCertificate(cerFile.buffer, {
   *   allowUnverifiedRevocation: true,
   * });
   * if (!result.ocspEvidence) {
   *   // firmar igualmente y dejar el documento pendiente de sellado
   * }
   * ```
   */
  async validateCertificate(
    cerBuffer: Buffer,
    options: CertificateValidationOptions = {},
  ): Promise<CertificateValidationResult> {
    const { serviceUrl, apiKey } = this.resolveConfiguration();

    try {
      const { data } = await axios.post<ValidateCertificateResponseBody>(
        `${serviceUrl}${VALIDATE_PATH}`,
        {
          certificate: cerBuffer.toString('base64'),
          ...(options.referenceDate && {
            referenceDate: options.referenceDate.toISOString(),
          }),
          ...(options.allowUnverifiedRevocation !== undefined && {
            allowUnverifiedRevocation: options.allowUnverifiedRevocation,
          }),
        },
        {
          headers: { 'x-api-key': apiKey },
          timeout: CERTIFICATE_VALIDATION_TIMEOUT_MS,
        },
      );

      return this.toResult(data);
    } catch (error) {
      throw this.translateError(error, cerBuffer);
    }
  }

  private toResult(
    body: ValidateCertificateResponseBody,
  ): CertificateValidationResult {
    if (!body?.validity || !body.trustChain || !body.revocation) {
      this.logger.error(
        'Certificate Validation Service respondió 200 con un cuerpo que no respeta su contrato.',
      );
      throw new CertificateValidationServiceUnavailableException();
    }

    return {
      serialNumber: body.serialNumber,
      validity: {
        notBefore: new Date(body.validity.notBefore),
        notAfter: new Date(body.validity.notAfter),
        evaluatedAt: new Date(body.validity.evaluatedAt),
      },
      trustChain: body.trustChain,
      revocation: {
        status: body.revocation.status,
        checkedAt: new Date(body.revocation.checkedAt),
      },
      ...(body.ocspEvidence && {
        ocspEvidence: {
          status: body.ocspEvidence.status,
          verifiedAt: new Date(body.ocspEvidence.verifiedAt),
          ocspResponse: body.ocspEvidence.ocspResponse,
          ocspUrl: body.ocspEvidence.ocspUrl,
        },
      }),
    };
  }

  private translateError(error: unknown, cerBuffer: Buffer): Error {
    if (error instanceof CertificateValidationServiceUnavailableException) {
      return error;
    }

    if (!axios.isAxiosError(error)) {
      this.logger.error(
        `Fallo inesperado al validar el certificado: ${error instanceof Error ? error.message : String(error)}`,
      );
      return new CertificateValidationServiceUnavailableException();
    }

    const status = error.response?.status;

    if (!status) {
      this.logger.error(
        `No se pudo conectar con Certificate Validation Service (code=${error.code ?? 'unknown'}).`,
      );
      return new CertificateValidationServiceUnavailableException();
    }

    const code = (error.response?.data as ErrorResponseBody | undefined)?.code;

    switch (code) {
      case 'INVALID_CERTIFICATE':
        return new CertificadoInvalidoException();
      case 'CERTIFICATE_EXPIRED':
      case 'CERTIFICATE_NOT_YET_VALID':
        return this.expiredException(cerBuffer);
      case 'INVALID_TRUST_CHAIN':
        return new CadenaConfianzaInvalidaException();
      case 'CERTIFICATE_REVOKED':
        return new CertificadoRevocadoException();
      case 'OCSP_SERVICE_UNAVAILABLE':
        this.logger.warn(
          'El SAT no respondió la consulta OCSP del certificado.',
        );
        return new OCSPNotAvailableException();
      default:
        // INVALID_API_KEY, INVALID_REQUEST, CERTIFICATE_VALIDATION_ERROR o algo que no conocemos:
        // ninguno es culpa de quien firma.
        this.logger.error(
          `Certificate Validation Service respondió HTTP ${status} con code=${code ?? 'desconocido'}.`,
        );
        return new CertificateValidationServiceUnavailableException();
    }
  }

  /**
   * `CertificadoExpiradoException` pide la fecha de fin de vigencia para su mensaje; el error
   * estándar no la trae, así que se lee del propio certificado (que ya se sabe legible: el servicio
   * lo habría rechazado antes como `INVALID_CERTIFICATE`).
   */
  private expiredException(cerBuffer: Buffer): Error {
    try {
      return new CertificadoExpiradoException(
        new Date(new X509Certificate(cerBuffer).validTo),
      );
    } catch {
      return new CertificadoInvalidoException();
    }
  }

  private resolveConfiguration(): { serviceUrl: string; apiKey: string } {
    const serviceUrl = this.configService.get<string>(
      'CERTIFICATE_VALIDATION_SERVICE_URL',
    );
    const apiKey = this.configService.get<string>(
      'CERTIFICATE_VALIDATION_SERVICE_API_KEY',
    );

    if (!serviceUrl || !apiKey) {
      this.logger.error(
        'Falta la configuración de Certificate Validation Service ' +
          '(CERTIFICATE_VALIDATION_SERVICE_URL / CERTIFICATE_VALIDATION_SERVICE_API_KEY).',
      );
      throw new CertificateValidationServiceUnavailableException();
    }

    return { serviceUrl: serviceUrl.replace(/\/+$/, ''), apiKey };
  }
}

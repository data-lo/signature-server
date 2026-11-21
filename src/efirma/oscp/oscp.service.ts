import { Injectable } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { X509Certificate } from 'crypto';
import { OCSPEvidence } from '../interfaces/OCSPEvidence.interface';
import { getCertStatus } from 'easy-ocsp';
import {
  OCSPNotAvailableException,
  CertificadoRevocadoException,
  OCSPInvalidResponseException,
} from '../efirma.exceptions';

const SAT_OCSP_URL = 'https://cfdi.sat.gob.mx/edofiel';
const SAT_OCSP_TIMEOUT_MS = 5000;

/** Estados que una respuesta OCSP puede reportar como evidencia (`revoked` se lanza aparte). */
const EVIDENCE_STATUSES: readonly OCSPEvidence['status'][] = [
  'good',
  'unknown',
];

@Injectable()
export class OscpService {
  private readonly logger = new Logger(OscpService.name);

  /**
   * Consulta en el respondedor OCSP del SAT si el certificado está revocado y devuelve la
   * respuesta firmada como evidencia.
   *
   * Cada resultado sale por un camino distinto, para que quien llama decida sin interpretar
   * mensajes:
   * - `good` o `unknown`: se devuelve la evidencia. `unknown` NO equivale a `good`: el SAT no
   *   reconoce el certificado, y quien selle decide qué hacer con ello.
   * - `revoked`: `CertificadoRevocadoException`, un rechazo definitivo.
   * - Sin respuesta (caída, timeout, red): `OCSPNotAvailableException`; repetir más tarde tiene
   *   sentido.
   * - Respuesta sin cuerpo firmado o con un estado inesperado: `OCSPInvalidResponseException`.
   *   Antes se devolvía `ocspResponse: ''`, una evidencia vacía que se sellaba como si fuera válida.
   *
   * `verifiedAt` es el momento de ESTA consulta: en un reintento no reemplaza la fecha de firma,
   * que sigue en `signedAt`.
   *
   * @param cerBuffer - Certificado público en DER. Nunca la llave privada.
   * @param emisor - Certificado del emisor inmediato, de `EfirmaService.validarCadenaConfianza`.
   * @returns La evidencia OCSP con la respuesta firmada en Base64.
   *
   * @throws {CertificadoRevocadoException} Si el SAT lo reporta revocado.
   * @throws {OCSPNotAvailableException} Si el SAT no responde.
   * @throws {OCSPInvalidResponseException} Si la respuesta no sirve como evidencia.
   *
   * @example
   * ```ts
   * const issuer = efirmaService.validarCadenaConfianza(cerBuffer);
   * const evidence = await ocspService.verifyRevokedOCSP(cerBuffer, issuer);
   * ```
   */
  async verifyRevokedOCSP(
    cerBuffer: Buffer,
    emisor: X509Certificate,
  ): Promise<OCSPEvidence> {
    let result: Awaited<ReturnType<typeof getCertStatus>>;
    this.logger.log('verificado la validez del certificado');
    try {
      result = await getCertStatus(cerBuffer, {
        ca: emisor.raw,
        ocspUrl: SAT_OCSP_URL,
        timeout: SAT_OCSP_TIMEOUT_MS,
        rawResponse: true,
        enableNonce: false,
      });
    } catch (err) {
      this.logger.error(
        `Fallo en consulta OCSP del certificado en el SAT ${(err as Error).message}`,
      );
      // El detalle va al log, no al firmante: ya quedó registrado arriba.
      throw new OCSPNotAvailableException();
    }
    if (result.status === 'revoked') {
      this.logger.warn(
        `Certificado revocado detectado OCSP: ${cerBuffer.toString('base64').slice(0, 20)}`,
      );
      throw new CertificadoRevocadoException(
        (result as any).revocationTime,
        (result as any).revocationReason,
      );
    }

    const status = result.status as OCSPEvidence['status'];
    if (!EVIDENCE_STATUSES.includes(status)) {
      this.logger.error(
        `El SAT respondió un estado OCSP inesperado: ${status}`,
      );
      throw new OCSPInvalidResponseException(`estado ${String(status)}`);
    }

    const rawResponse = (result as any).rawResponse as
      | Uint8Array
      | Buffer
      | undefined;
    if (!rawResponse || rawResponse.length === 0) {
      this.logger.error('El SAT respondió el OCSP sin la respuesta firmada.');
      throw new OCSPInvalidResponseException('respuesta sin cuerpo firmado');
    }

    // Sólo el estado: la respuesta cruda no aporta al log y lo infla.
    this.logger.log(`OCSP Response from SAT: ${status}`);
    return {
      status,
      verifiedAt: new Date(),
      ocspResponse: Buffer.from(rawResponse).toString('base64'),
      ocspUrl: SAT_OCSP_URL,
    };
  }
}

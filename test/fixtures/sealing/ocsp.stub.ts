import { X509Certificate } from 'crypto';

import {
  CertificadoRevocadoException,
  OCSPInvalidResponseException,
  OCSPNotAvailableException,
} from './../../../src/efirma/efirma.exceptions';
import { OCSPEvidence } from './../../../src/efirma/interfaces/OCSPEvidence.interface';

/** Lo que el "SAT" contesta en una consulta. */
export type OcspOutcome =
  | 'good'
  | 'unknown'
  | 'unavailable'
  | 'revoked'
  | 'invalid';

/**
 * Adaptador OCSP controlado: reemplaza a `OscpService` en las pruebas para que la suite no dependa
 * del SAT real.
 *
 * Cada certificado (por su huella SHA-256) tiene una cola de respuestas; cuando se vacía, contesta
 * `fallback`. Responde con las mismas excepciones que `OscpService`, así que el resto del flujo
 * (clasificación, reintentos) es el real.
 *
 * @example
 * ```ts
 * const ocsp = new ControlledOcspResponder();
 * ocsp.script(TEST_CERTIFICATE_PEM_1, 'unavailable', 'good');
 * ```
 */
export class ControlledOcspResponder {
  private readonly queues = new Map<string, OcspOutcome[]>();
  private readonly calls = new Map<string, number>();
  fallback: OcspOutcome = 'good';

  /**
   * Programa las siguientes respuestas para un certificado.
   *
   * @param certificatePem - Certificado del firmante.
   * @param outcomes - Respuestas en orden.
   * @returns El propio adaptador.
   */
  script(certificatePem: string, ...outcomes: OcspOutcome[]): this {
    this.queues.set(fingerprint(certificatePem), outcomes);
    return this;
  }

  /**
   * Consultas recibidas para un certificado.
   *
   * @param certificatePem - Certificado del firmante.
   * @returns Cuántas veces se preguntó por él.
   */
  callsFor(certificatePem: string): number {
    return this.calls.get(fingerprint(certificatePem)) ?? 0;
  }

  /**
   * Misma firma que `OscpService.verifyRevokedOCSP`.
   *
   * @param cerBuffer - Certificado en DER.
   * @returns La evidencia, según el guion.
   *
   * @throws {OCSPNotAvailableException | CertificadoRevocadoException | OCSPInvalidResponseException}
   */
  async verifyRevokedOCSP(cerBuffer: Buffer): Promise<OCSPEvidence> {
    const key = new X509Certificate(cerBuffer).fingerprint256;
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
    const outcome = this.queues.get(key)?.shift() ?? this.fallback;

    switch (outcome) {
      case 'unavailable':
        throw new OCSPNotAvailableException();
      case 'revoked':
        throw new CertificadoRevocadoException(
          new Date('2026-10-01T00:00:00.000Z'),
          'keyCompromise',
        );
      case 'invalid':
        throw new OCSPInvalidResponseException('respuesta sin cuerpo firmado');
      default:
        return {
          status: outcome,
          verifiedAt: new Date(),
          ocspResponse: Buffer.from(`ocsp-${outcome}-${key}`).toString(
            'base64',
          ),
          ocspUrl: 'https://ocsp.test.invalid/edofiel',
        };
    }
  }
}

/**
 * Doble de `EfirmaService` con lo ÚNICO que el sellado le pide: la cadena de confianza del
 * certificado público. No expone nada que reciba una llave privada o una contraseña: si el flujo
 * las necesitara, las pruebas no compilarían.
 */
export const controlledEfirma = {
  validarCadenaConfianza: (cerBuffer: Buffer): X509Certificate =>
    new X509Certificate(cerBuffer),
};

/**
 * Huella SHA-256 de un certificado PEM.
 *
 * @param certificatePem - Certificado.
 * @returns La huella.
 */
function fingerprint(certificatePem: string): string {
  return new X509Certificate(certificatePem).fingerprint256;
}

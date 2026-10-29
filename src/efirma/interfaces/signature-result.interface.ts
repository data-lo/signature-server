import { OCSPEvidence } from './OCSPEvidence.interface';

export interface SignatureResult {
  signatureBase64: string;
  algorithm: 'sha256';
  signedAt: Date;
  certificate: SATCertificate;
  /**
   * Comprobación de revocación ante el SAT en el momento de firmar.
   *
   * OPCIONAL porque el respondedor OCSP del SAT se cae con frecuencia y su caída no puede impedir
   * que alguien firme. Cuando falta, la firma es válida pero su evidencia todavía no acredita que
   * el certificado siguiera activo, y el documento queda pendiente de sellar hasta obtenerla (ver
   * `documents.sealing_pending_at`).
   */
  ocspEvidence?: OCSPEvidence;
}

interface SATCertificate {
  rfc: string;
  name: string;
  issuer: string;
  serialNumber: string;
  certificateNumber: string;
  certificatePem: string;
}

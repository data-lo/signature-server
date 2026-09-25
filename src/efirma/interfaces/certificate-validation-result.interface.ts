import { OCSPEvidence } from './OCSPEvidence.interface';

/**
 * Estado de revocación que informa Certificate Validation Service.
 *
 * `UNVERIFIED` sólo aparece cuando se pidió tolerar que el SAT no respondiera
 * (`allowUnverifiedRevocation`); un certificado revocado nunca llega aquí, llega como
 * `CertificadoRevocadoException`.
 */
export type CertificateRevocationStatus = 'GOOD' | 'UNKNOWN' | 'UNVERIFIED';

/** Opciones de `CertificateValidationApiService.validateCertificate`. */
export interface CertificateValidationOptions {
  /** Fecha contra la que se evalúa la vigencia. Por defecto, ahora. */
  referenceDate?: Date;
  /** Si es `true`, que el SAT no responda no es un error: se devuelve sin `ocspEvidence`. */
  allowUnverifiedRevocation?: boolean;
}

/** Resultado de una validación aceptada, ya con las fechas convertidas a `Date`. */
export interface CertificateValidationResult {
  serialNumber: string;
  validity: { notBefore: Date; notAfter: Date; evaluatedAt: Date };
  trustChain: { issuer: string; root: string };
  revocation: { status: CertificateRevocationStatus; checkedAt: Date };
  /** Ausente cuando el SAT no respondió y se permitió seguir sin verificar la revocación. */
  ocspEvidence?: OCSPEvidence;
}

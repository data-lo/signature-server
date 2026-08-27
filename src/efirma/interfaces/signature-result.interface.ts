import { OCSPEvidence } from './OCSPEvidence.interface';

export interface SignatureResult {
  signatureBase64: string;
  algorithm: 'sha256';
  signedAt: Date;
  certificate: SATCertificate;
  ocspEvidence: OCSPEvidence;
}

interface SATCertificate {
  rfc: string;
  name: string;
  issuer: string;
  serialNumber: string;
  certificateNumber: string;
  certificatePem: string;
}

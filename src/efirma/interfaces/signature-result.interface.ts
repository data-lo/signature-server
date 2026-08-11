import { OCSPEvidence } from './OCSPEvidence.interface';

export interface SignatureResult {
    
    originalHash: string;
    signatureBase64: String;
    algorithm: 'sha256';
    signedAt: Date;
    certificate: SATCertificate;
    ocspEvidence: OCSPEvidence;
}

interface SATCertificate {
    rfc: string,
    name: string,
    serialNumber: string,
    certificateNumber: string,
    certificatePem:string
}
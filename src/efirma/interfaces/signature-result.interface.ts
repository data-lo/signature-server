
export interface SignatureResult {
    
    originalHash: string;
    signatureBase64: String;
    algorithm: 'sha256';
    signedAt: Date;
    certificate: SATCertificate
}

interface SATCertificate {
    rfc: string,
    name: string,
    serialNumber: string,
    certificateNumber: string,
    certificatePem:string
}
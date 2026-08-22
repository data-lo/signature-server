export interface OCSPEvidence {
    status: 'good' | 'unknown';
    verifiedAt: Date;
    ocspResponse: string;
    ocspUrl: string; 
}
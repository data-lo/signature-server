export interface OCSPEvidence {
    status: 'good' | 'unknown';
    verifiedAt: Date;
    thisUpdate: Date;
    nextUpdate: Date;
    ocspResponse: string;
    ocspUrl: string; 
}
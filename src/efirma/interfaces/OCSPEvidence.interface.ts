export interface OCSPEvidence {
    status: 'good' | 'unknown';
    verifiedAt: Date;
    thisUpdate: Date;
    nextUpdate: Date;
    rawResponseBase64: string;
    ocspUrl: string; 
}
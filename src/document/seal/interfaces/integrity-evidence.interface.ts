export interface IntegrityEvidence {
  isValid: boolean;
  processedHash: string;
  fileBase64: string;
  evidenceId: string;
  issuedAt: Date | null;
  certificatePdfBase64?: string;
}

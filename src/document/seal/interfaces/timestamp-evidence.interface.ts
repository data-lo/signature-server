export interface TimestampEvidence {
  isValid: boolean;
  processedHash: string;
  fileBase64: string;
  evidenceId: string;
  issuedAt: Date | null;
}

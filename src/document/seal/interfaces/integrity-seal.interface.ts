export interface IntegritySeal {
  isValid: boolean;
  processedHash: string;
  tokenBase64: string;
  evidenceId: string;
  certificatePdfBase64: string;
}

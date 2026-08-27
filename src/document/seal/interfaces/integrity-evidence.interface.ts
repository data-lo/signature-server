export interface IntegrityEvidence {
  isValid: boolean;
  processedHash: string;
  fileBase64: string;
  evidenceId: string;
  issuedAt: Date | null;
  certificatePdfBase64?: string;
  /**
   * Serie y `notBefore` del certificado del PSC embebido en `fileBase64`, extraídos con
   * `extractTsaCertificateInfo`. Ausentes cuando la extracción falló (o todavía no se intentó,
   * en evidencias históricas) — ver `SealMapper` y `GetPublicDocumentUseCase`.
   */
  certificateSerialNumber?: string;
  certificateIssuedAt?: Date;
}

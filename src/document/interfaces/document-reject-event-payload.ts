export interface DocumentRejectPayload {
  signerId: string;
  documentId: string;
  ipAddress?: string;
  verificationCodeId?: string;
}

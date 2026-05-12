export interface DocumentSignEventPayload {
  signerId: string;
  documentId: string;
  ipAddress?: string;
  verificationCodeId?: string;
}

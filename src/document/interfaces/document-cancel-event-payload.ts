export interface DocumentCancelPayload {
  signerId: string;
  documentId: string;
  ipAddress?: string;
  verificationCodeId?: string;
}

export interface VerificationCodeObject {
  code: string;
  expiredAt: Date;
  type: string;
  signerId: string;
  documentId: string;
}
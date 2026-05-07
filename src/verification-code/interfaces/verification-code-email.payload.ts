export interface VerificationCodeEmailPayload {
    to: string,
    documentName: string,
    signerName: string,
    code: string
}
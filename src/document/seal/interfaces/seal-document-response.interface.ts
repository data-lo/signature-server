export interface SealDocumentResponse {
  documentId: string;
  signHashHex: string;
  timeStamp: TimestampSealResponse;
  nom151: Nom151SealResponse;
}

export interface TimestampSealResponse {
  status: boolean;
  hashProcessed: string;
  fileBase64: string;
  uuid: string;
}

export interface Nom151SealResponse {
  status: boolean;
  hashProcessed: string;
  file: string;
  uuid: string;
  pdfFile: string;
}

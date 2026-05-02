import { FILE_STATUS_ENUM } from '../enums/file-status-enum';

export interface FileMetadata {
  status: FILE_STATUS_ENUM;
  fileId: string;
  bucket: string;
  fileType: string;
  originalName?: string;
  ip: string;
  uploadDate: Date;
}

export interface GetFileResponse {
  fileId: string;
  bucket: string;
  bucketType:
    | 'signatures_images'
    | 'created_documents'
    | 'signed_documents'
    | 'oficial_cards';
  secureUrl: string;
  expiresIn: number;
  originalName?: string;
}

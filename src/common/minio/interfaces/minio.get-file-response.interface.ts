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
  secureUrl: string;
  expiresIn: number;
}

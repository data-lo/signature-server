import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DocumentStatus } from '../lib/document-status';


export class DocumentCoordDto {
  @IsNumber()
  left: number;

  @IsNumber()
  right: number;

  @IsNumber()
  top: number;

  @IsNumber()
  bottom: number;
}

export class CreateDocumentDto {
  @IsString()
  @IsNotEmpty()
  bucketId: string;

  @IsString()
  @IsNotEmpty()
  file_name: string;

  @IsString()
  @IsNotEmpty()
  url: string;

  @IsString()
  @IsNotEmpty()
  ip: string;

  @IsString()
  @IsNotEmpty()
  otp_id: string;

  @IsString()
  @IsNotEmpty()
  userId: string;

  @Type(() => Date)
  @IsDate()
  signed_at: Date;

  @IsNumber()
  total_pages: number;

  @IsString()
  @IsNotEmpty()
  file_type: string;

  @IsString()
  @IsNotEmpty()
  hashing_before: string;

  @IsString()
  @IsNotEmpty()
  hashing_after: string;

  @IsString()
  @IsNotEmpty()
  request_signer_id: string;

  @IsString()
  @IsNotEmpty()
  signer: string;

  @IsEnum(DocumentStatus)
  status: DocumentStatus;

  @IsBoolean()
  is_notified: boolean;

  @ValidateNested()
  @Type(() => DocumentCoordDto)
  coord: DocumentCoordDto;
}

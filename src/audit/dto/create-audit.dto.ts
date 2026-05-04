import { Type } from 'class-transformer';
import { IsString, IsDate, IsNumber, IsOptional } from 'class-validator';

export class CreateAuditDto {
    @IsString()
    documentId: string;

    @IsString()
    verificationCodeId: string;

    @IsOptional()
    @IsDate()
    @Type(() => Date)
    signedAt: Date;

    @IsString()
    integrityHash: string;
}
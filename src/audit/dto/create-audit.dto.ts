import { Type } from 'class-transformer';
import { IsArray, IsEnum, ValidateNested, IsDate, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuditAction } from '../schema/audit-document';

class UserActionDto {
  @ApiProperty()
  @IsString()
  userId: string;

  @ApiProperty({ enum: AuditAction })
  @IsEnum(AuditAction)
  action: AuditAction;
}

export class CreateAuditDto {
  @ApiProperty()
  @IsString()
  documentId: string;

  @ApiProperty({ enum: AuditAction })
  @IsEnum(AuditAction)
  operation: AuditAction;

  @ApiProperty()
  @IsString()
  ipAddress: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  verificationCodeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  signedAt?: Date;

  @ApiPropertyOptional({ type: [UserActionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UserActionDto)
  users?: UserActionDto[];
}

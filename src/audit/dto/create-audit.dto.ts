import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateAuditDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del documento auditado', format: 'uuid' })
  @IsUUID()
  @IsNotEmpty()
  documentId: string;

  @ApiProperty({ example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', description: 'UUID del código de verificación utilizado', format: 'uuid' })
  @IsUUID()
  @IsNotEmpty()
  verificationCodeId: string;

  @ApiPropertyOptional({ example: '2024-01-15T10:30:00Z', description: 'Fecha y hora en que se firmó el documento' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  signedAt?: Date;

  @ApiProperty({ example: 'sha256:abc123def456...', description: 'Hash SHA-256 de integridad del documento firmado' })
  @IsString()
  @IsNotEmpty()
  integrityHash: string;
}

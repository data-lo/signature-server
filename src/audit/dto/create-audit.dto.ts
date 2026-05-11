
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TypeOfOperation } from '../schema/audit-document';
import { IsDate, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

/** Par usuario-acción que se registra dentro de un evento de auditoría. */
class UserActionDto {
  @ApiProperty()
  @IsString()
  userId: string;

  @ApiProperty({ enum: TypeOfOperation })
  @IsEnum(TypeOfOperation)
  action: TypeOfOperation;
}

/**
 * DTO para crear un registro de auditoría.
 *
 * Campos mínimos obligatorios: documentId, operation e ipAddress.
 * Los campos verificationCodeId y signedAt son opcionales en el DTO pero pueden
 * volverse obligatorios dependiendo de la operación (validados en AuditService).
 * Los campos de hash (integrityHash, cipher, chainHash) los calcula el servicio
 * internamente; no se reciben desde el cliente.
 */
export class CreateAuditDto {
  /** ID del documento sobre el que se registra el evento. */
  @ApiProperty()
  @IsString()
  documentId: string;

  /** Tipo de operación que origina este registro. Determina qué campos son requeridos. */
  @ApiProperty({ enum: TypeOfOperation })
  @IsEnum(TypeOfOperation)
  operation: TypeOfOperation;

  /** IP del cliente que realiza la operación. Obligatoria en todos los casos. */
  @ApiProperty({ description: 'IP del cliente que realiza la operación' })
  @IsString()
  ipAddress: string;

  /**
   * ID del código de verificación (OTP) consumido en la operación.
   * El servicio lo exigirá si la operación es SIGN, APPROVE o REJECT.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  verificationCodeId?: string;

  /**
   * Fecha y hora de la firma. El servicio lo exigirá si la operación es SIGN.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  signedAt?: Date;

  /** Usuarios involucrados en el evento y la acción que cada uno realizó. */
  @ApiPropertyOptional({ type: [UserActionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UserActionDto)
  users?: UserActionDto[];


  @ApiProperty({ example: 'sha256:abc123def456...', description: 'Hash SHA-256 de integridad del documento firmado' })
  @IsString()
  @IsNotEmpty()
  integrityHash: string;
}

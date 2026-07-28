import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Transform, Type, plainToInstance } from 'class-transformer';
import { SignatureCoordinatesDto } from './signature-coordinates.dto';

function parseJsonArray({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export class CreateDocumentDto {
  @ApiProperty({
    example: ['a1b2c3d4-e5f6-7890-abcd-ef1234567890'],
    description:
      'UUIDs de los usuarios que deben firmar el documento, en el orden en que se les solicitará la firma',
    type: [String],
  })
  @Transform(parseJsonArray)
  @IsArray()
  @ArrayNotEmpty({ message: 'Debe especificar al menos un firmante' })
  @IsUUID('4', { each: true })
  signerIds: string[];

  @ApiPropertyOptional({
    example: ['b2c3d4e5-f6a7-8901-bcde-f12345678901'],
    description:
      'UUIDs de los usuarios de la plataforma que solo observarán el estado del documento (watchers)',
    type: [String],
  })
  @Transform(parseJsonArray)
  @IsArray()
  @IsOptional()
  @IsUUID('4', { each: true })
  watcherIds?: string[];

  @ApiPropertyOptional({
    example: ['invitado@correo.com'],
    description:
      'Correos de personas sin cuenta en la plataforma, invitadas solo a observar (watchers)',
    type: [String],
  })
  @Transform(parseJsonArray)
  @IsArray()
  @IsOptional()
  @IsEmail({}, { each: true })
  watcherEmails?: string[];

  @ApiPropertyOptional({
    example: ['c3d4e5f6-a7b8-9012-cdef-123456789012'],
    description:
      'UUIDs de los usuarios de la plataforma que revisarán el documento (reviewers), sin bloquear el flujo de firma todavía',
    type: [String],
  })
  @Transform(parseJsonArray)
  @IsArray()
  @IsOptional()
  @IsUUID('4', { each: true })
  reviewerIds?: string[];

  @ApiPropertyOptional({
    example: ['revisor@correo.com'],
    description:
      'Correos de personas sin cuenta en la plataforma, invitadas a revisar (reviewers)',
    type: [String],
  })
  @Transform(parseJsonArray)
  @IsArray()
  @IsOptional()
  @IsEmail({}, { each: true })
  reviewerEmails?: string[];

  @ApiProperty({ type: SignatureCoordinatesDto })
  @ValidateNested()
  @Type(() => SignatureCoordinatesDto)
  @Transform(({ value }) => {
    let parsed = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch {
        return value;
      }
    }
    return plainToInstance(SignatureCoordinatesDto, parsed);
  })
  @IsOptional()
  signatureCoordinates: SignatureCoordinatesDto;

  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'PDF del documento a firmar.',
  })
  file: any;
}

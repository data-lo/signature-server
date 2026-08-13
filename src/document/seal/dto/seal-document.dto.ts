import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsObject,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SatCertificateDto {
  @ApiProperty({ example: 'XAXX010101000' })
  @IsString()
  @IsNotEmpty()
  rfc: string;

  @ApiProperty({ example: 'EMPRESA DEMO SA DE CV' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: '00001000000512345678' })
  @IsString()
  @IsNotEmpty()
  serialNumber: string;

  @ApiProperty({ example: '30001000000500003416' })
  @IsString()
  @IsNotEmpty()
  certificateNumber: string;

  @ApiProperty({
    description: 'Certificado en formato PEM.',
    example: '-----BEGIN CERTIFICATE-----\\n...\\n-----END CERTIFICATE-----',
  })
  @IsString()
  @IsNotEmpty()
  certificatePem: string;
}

export class SealSignatureDto {
  @ApiProperty({ description: 'Firma digital codificada en Base64.' })
  @IsString()
  @IsNotEmpty()
  signatureBase64: string;

  @ApiProperty({ example: 'sha256' })
  @IsString()
  @IsNotEmpty()
  algorithm: string;

  @ApiProperty({
    example: '2026-08-12T18:45:56.000Z',
    description: 'Fecha y hora ISO 8601 en la que se realizó la firma.',
  })
  @IsDateString()
  signedAt: string;

  @ApiProperty({ type: () => SatCertificateDto })
  @IsObject()
  @ValidateNested()
  @Type(() => SatCertificateDto)
  certificate: SatCertificateDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Evidencia OCSP entregada por el proveedor de firma. Su estructura se conserva sin modificar.',
  })
  @IsObject()
  ocspEvidence: Record<string, unknown>;
}

export class SealDocumentDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Identificador del documento al que se le generarán los sellos.',
  })
  @IsUUID('4')
  @IsNotEmpty()
  documentId: string;

  @ApiProperty({
    description: 'Hash original del documento firmado.',
    example: '6d59d45a9518d0dab7671301afa2e262375024d7211bf14e0b4bf23eaf146f14',
  })
  @IsString()
  @IsNotEmpty()
  originalHash: string;

  @ApiProperty({
    type: () => SealSignatureDto,
    isArray: true,
    description:
      'Firmas electrónicas de cada usuario participante que intervino en el documento.',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SealSignatureDto)
  signatures: SealSignatureDto[];
}

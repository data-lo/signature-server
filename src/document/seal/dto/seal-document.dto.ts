import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';


export class OcspEvidence {
  @IsString()
  @IsNotEmpty()
  @ApiProperty({example: 'good'})
  status: 'good' | 'unknown';

  @IsString()
  @IsNotEmpty()
  @ApiProperty({example: '2026-08-19T23:57:42.371Z'})
  verifiedAt: string;

  @IsString()
  @IsNotEmpty()
  @ApiProperty({example: 'MIIIQQoBAKCCCDowggg2BgkrBgEFBQcwA...'})
  ocspResponse: string;

  @IsString()
  @IsNotEmpty()
  @ApiProperty({example: '"https://cfdi.sat.gob.mx/edofiel"'})
  ocspUrl: string;
}

export class SatCertificateDto {
  @ApiProperty({ example: 'XAXX010101000' })
  @IsString()
  @IsNotEmpty()
  rfc: string;

  @ApiProperty({ example: 'EMPRESA DEMO SA DE CV' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({example: 'SERVICIO DE ADMINISTRACION TIRIBUTARIA'})
  @IsString()
  @IsNotEmpty()
  issuer:string;

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

  /**
   * Opcional de verdad, no solo en la documentación. `EfirmaService.firmar` sí la produce hoy, pero
   * las firmas guardadas ANTES de que existiera la verificación OCSP no la tienen, y Seal Service
   * no la usa para construir el hash (ver `buildSignatureHash`: canonicaliza certificado,
   * algoritmo, firma y fecha, nada más). Un documento viejo tiene que poder sellarse igual.
   *
   * Bug corregido: el docblock ya decía "opcional" y el decorador era `ApiPropertyOptional`, pero
   * el tipo la declaraba obligatoria y le faltaba `@IsOptional()` — la intención documentada y la
   * validación real habían divergido.
   */
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Evidencia OCSP entregada por el proveedor de firma. Su estructura se conserva sin modificar.',
  })
  @IsOptional()
  @IsObject()
  ocspEvidence?: OcspEvidence;
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

  /** Sellar un documento sin ninguna firma no tiene sentido: el hash del proveedor se construye a partir de ellas. */
  @ApiProperty({
    type: () => SealSignatureDto,
    isArray: true,
    description:
      'Firmas electrónicas de cada usuario participante que intervino en el documento.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SealSignatureDto)
  signatures: SealSignatureDto[];
}

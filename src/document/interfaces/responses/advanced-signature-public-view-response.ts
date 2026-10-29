import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';

/**
 * Constancia pública de UNA firma avanzada — lo que ve quien escanea el código QR estampado en el
 * documento (historia "Generar código QR para firmas avanzadas").
 *
 * Deliberadamente NO incluye el certificado ni la firma criptográfica en sí: es una constancia de
 * quién firmó y cuándo, consultable por cualquiera que tenga el documento en la mano, no un
 * volcado de la evidencia. Tampoco expone el correo del firmante, que no aporta a la verificación
 * y sí sería un dato personal más filtrado por una ruta sin autenticación.
 */
export class AdvancedSignaturePublicViewData {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID del documento firmado',
    format: 'uuid',
  })
  documentId: string;

  @ApiProperty({
    example: 'Convenio_2026_Manuel_Balderrama.pdf',
    description: 'Nombre del documento firmado',
  })
  fileName: string;

  @ApiProperty({
    example: 'MANUEL BALDERRAMA CHAVEZ',
    description:
      'Nombre del firmante. Se toma del certificado de e.firma cuando está disponible (es el nombre con el que el SAT lo tiene registrado) y, si no, de su perfil en la plataforma.',
  })
  signerName: string;

  @ApiProperty({
    example: 'XAXX010101000',
    description:
      'RFC del firmante, extraído del certificado de e.firma. null en firmas anteriores a que se guardara la evidencia del certificado.',
    nullable: true,
  })
  rfc: string | null;

  @ApiProperty({
    example: '00001000000512345678',
    description:
      'Número de serie del certificado de e.firma con el que se firmó — identifica de forma única el certificado usado.',
    nullable: true,
  })
  certificateSerialNumber: string | null;

  @ApiProperty({
    example: '2026-08-14T18:24:11.000Z',
    description: 'Fecha y hora en que el firmante completó su firma (UTC).',
    format: 'date-time',
  })
  signedAt: string;
}

export class AdvancedSignaturePublicViewResponse extends BaseResponse {
  @ApiProperty({
    type: AdvancedSignaturePublicViewData,
    description: 'Constancia pública de la firma avanzada consultada',
  })
  data: AdvancedSignaturePublicViewData;
}

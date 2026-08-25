import { ApiProperty } from '@nestjs/swagger';

/**
 * Cuerpo `multipart/form-data` de `POST /api/v1/signature-capture-sessions/:id/signature`.
 *
 * Existe sólo para que Swagger describa el multipart; quien procesa el archivo es el
 * `FileInterceptor` del controller. El PNG viaja como archivo y **nunca como Base64 en JSON**:
 * una firma en Base64 termina inevitablemente en un log, en una traza de error o en una columna
 * de texto de la base, que es exactamente donde no debe estar la rúbrica de una persona.
 */
export class SaveHandwrittenSignatureDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description:
      'Imagen PNG de la firma manuscrita, tal como la exporta el canvas (`toBlob`).',
  })
  signature: any;
}

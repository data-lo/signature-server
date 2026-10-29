import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { SEAL_ARTIFACT_ENUM } from '../seal/seal-artifacts';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `GET /document/public/:id/seal/:artifact` — descarga de un artefacto del sello, sin autenticación. */
export function ApiGetPublicSealArtifact() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Descarga un artefacto de la constancia de conservación (sin autenticación)',
      description:
        'Público (sin JWT ni x-api-key, ver SkipJwtAuth) — respalda los botones de descarga de /public/documents/:id. Sirve lo que ya está guardado en document_seals y NO vuelve a llamar al PSC: Seal Service no persiste nada, así que esa fila es la única copia que existe. Responde 404 si el documento no está firmado, si no tiene sello (solo se sellan los documentos con firma avanzada, y el sellado es best-effort) o si ese artefacto en concreto no vino en la respuesta del proveedor.',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiParam({
      name: 'artifact',
      description:
        'Artefacto a descargar: nom151 (constancia en PDF), timestamp (token RFC 3161) o canonical (cadena canónica sellada, en texto plano — no es XML pese a como la nombra la historia, ver SEAL_ARTIFACT_ENUM).',
      enum: SEAL_ARTIFACT_ENUM,
    }),
    ApiResponse({
      status: 200,
      description: 'Archivo del artefacto solicitado',
    }),
    ApiResponse({
      status: 404,
      description: 'Documento, constancia o artefacto no encontrado',
      type: NotFoundResponse,
    }),
  );
}

import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `GET /document/public/:id/audit-xml` — expediente de auditoría en XML, sin autenticación. */
export function ApiGetPublicDocumentAuditXml() {
  return applyDecorators(
    ApiOperation({
      summary: 'Descarga el XML de auditoría del documento (sin autenticación)',
      description:
        'Público (sin JWT ni x-api-key, ver SkipJwtAuth) — respalda el botón "Descargar XML de auditoría" de /public/documents/:id. Arma el archivo EN EL MOMENTO con la evidencia que ya existe (documento, colaboradores, document_seals y los PDFs en MinIO) y no persiste nada: el XML no se guarda en PostgreSQL ni en MinIO, y la descarga no modifica documento, firmas, sellos ni archivos. Incluye el PDF original sin firmar (created_documents), el firmado (signed_documents) y, cuando existe, el definitivo con hoja de firmas (finalized_documents), los tres en Base64; la cadena canónica del sello va como texto UTF-8 —no es Base64 ni XML anidado—. Cada firmante lleva correo, CURP, fecha, tipo y estado de firma, IP y geolocalización cuando existen, más todos los campos de advanced_signature si firmó con e.firma o su rúbrica PNG en Base64 si firmó de forma simple. Responde 404 si el documento no existe o no está firmado, y 422 si falta una evidencia obligatoria.',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiResponse({
      status: 200,
      description:
        'Archivo XML de auditoría (application/xml, como descarga adjunta)',
    }),
    ApiResponse({
      status: 404,
      description: 'El documento no existe o todavía no está firmado',
      type: NotFoundResponse,
    }),
    ApiResponse({
      status: 422,
      description:
        'Al documento le falta una evidencia obligatoria para armar el expediente',
    }),
  );
}

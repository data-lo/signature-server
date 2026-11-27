import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';

import {
  VERIFICATION_ARTIFACT_TYPE_ENUM,
  VERIFICATION_MESSAGES,
  VERIFICATION_STATUS_ENUM,
} from '../public-verification/public-verification.types';

/** `POST /document/public/verify` — verificación pública de un XML de auditoría o un PDF final. */
export function ApiVerifyPublicDocument() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Verifica un XML de auditoría o un PDF final por su SHA-256 (sin autenticación)',
      description:
        'Público (sin JWT ni x-api-key) y con rate limiting por IP (10 peticiones por minuto). Recibe UN archivo en el campo `file`: un XML de auditoría (.xml, hasta 128 MiB) o un PDF final con hoja de firmas (.pdf, hasta 25 MiB). Calcula el SHA-256 de sus bytes originales en streaming y lo busca en `document_seals.verification_record_digest` (XML) o `documents.final_document_digest` (PDF). Si un XML no coincide, lee el `documentId` de su raíz con un parser estricto (sin DTD ni entidades) y responde COMPROMISED si el documento existe o NOT_FOUND si no. El archivo no se guarda, no se cachea y no se registra. Todos los resultados, incluidos los de archivo no admitido o inválido, responden 200 con `data.status`; sólo VALID incluye datos del documento.',
    }),
    ApiConsumes('multipart/form-data'),
    ApiBody({
      schema: {
        type: 'object',
        required: ['file'],
        properties: {
          file: {
            type: 'string',
            format: 'binary',
            description: 'XML de auditoría (.xml) o PDF final (.pdf)',
          },
        },
      },
    }),
    ApiResponse({
      status: 200,
      description: 'Resultado de la verificación',
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: {
            type: 'string',
            example: VERIFICATION_MESSAGES[VERIFICATION_STATUS_ENUM.VALID],
          },
          data: {
            type: 'object',
            required: ['status', 'message'],
            properties: {
              status: {
                type: 'string',
                enum: Object.values(VERIFICATION_STATUS_ENUM),
              },
              artifactType: {
                type: 'string',
                enum: Object.values(VERIFICATION_ARTIFACT_TYPE_ENUM),
              },
              message: { type: 'string' },
              document: {
                type: 'object',
                description: 'Sólo cuando status es VALID',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  fileName: { type: 'string' },
                  signedAt: {
                    type: 'string',
                    format: 'date-time',
                    nullable: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
    ApiResponse({
      status: 429,
      description: 'Demasiadas verificaciones desde la misma IP',
    }),
  );
}

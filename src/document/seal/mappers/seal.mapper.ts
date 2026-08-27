import { DeepPartial } from 'typeorm';

import { SealDocumentDto } from '../dto/seal-document.dto';
import { SealEntity } from '../entities/seal.entity';
import { SealDocumentResponse } from '../interfaces/seal-document-response.interface';

/** Traduce la respuesta del proveedor externo al modelo de persistencia local. */
export class SealMapper {
  static toEntity(
    dto: SealDocumentDto,
    response: SealDocumentResponse,
  ): DeepPartial<SealEntity> {
    return {
      // `documentId` sale del DTO, no de la respuesta: es NUESTRO identificador y la FK de la
      // tabla — si el proveedor devolviera otro (o ninguno), la evidencia quedaría colgada de un
      // documento equivocado.
      documentId: dto.documentId,
      signatureHash: response.hashHex,
      /**
       * La cadena canónica que devolvió el proveedor: la preimagen literal de `hashHex`. Con ella
       * guardada, verificar el sello no requiere reimplementar la canonicalización de Seal Service
       * ni conservar el request original — basta recomputar `sha256(canonicalPayload)` y comparar
       * contra `signature_hash`. La versión del algoritmo va embebida como su primer segmento
       * (ver `SealDocumentResponse.hashVersion`), así que no hace falta una columna aparte.
       *
       * Las ENTRADAS de esa cadena tampoco se pierden: siguen en `collaborators.advanced_signature`
       * de este mismo documento, así que la evidencia se puede auditar de punta a punta.
       */
      canonicalPayload: response.canonicalString,
      /**
       * Bug corregido: `sealedAt` se descartaba, contradiciendo el criterio de esta misma clase
       * ("Seal Service no tiene base de datos... esta es la única oportunidad de guardarlo"). Es el
       * momento de emisión que reporta el PSC, y es lo que la hoja de evidencia imprime como
       * "EMITIDO"; `created_at` no sirve de sustituto, porque mide cuándo insertamos la fila.
       */
      sealedAt: response.sealedAt ? new Date(response.sealedAt) : null,
      timestampEvidence: {
        isValid: response.timeStamp.status,
        processedHash: response.timeStamp.hashProcessed,
        fileBase64: response.timeStamp.fileBase64,
        evidenceId: response.timeStamp.uuid,
        issuedAt: response.sealedAt ? new Date(response.sealedAt) : null,
      },
      integrityEvidence: {
        isValid: response.nom151.status,
        processedHash: response.nom151.hashProcessed,
        fileBase64: response.nom151.file,
        evidenceId: response.nom151.uuid,
        issuedAt: response.sealedAt ? new Date(response.sealedAt) : null,
        certificatePdfBase64: response.nom151.pdfFile,
      },
    };
  }
}

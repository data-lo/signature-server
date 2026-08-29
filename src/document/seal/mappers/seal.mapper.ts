import { DeepPartial } from 'typeorm';

import { SealDocumentDto } from '../dto/seal-document.dto';
import { SealEntity } from '../entities/seal.entity';
import { SealDocumentResponse } from '../interfaces/seal-document-response.interface';
import { IntegrityEvidence } from '../interfaces/integrity-evidence.interface';
import { extractTsaCertificateInfo } from '../utils/tsa-certificate.util';

/** Traduce la respuesta del proveedor externo al modelo de persistencia local. */
export class SealMapper {
  /**
   * `dto` se acota a `documentId` porque es lo ÚNICO que se toma de la petición: el resto de la
   * fila sale de la respuesta del proveedor. Declararlo así deja que lo usen los dos sellados —el
   * avanzado con su `SealDocumentDto` y el simple con el suyo, que tiene otra forma— sin fabricar
   * un DTO de mentira para satisfacer al tipo.
   */
  static toEntity(
    dto: Pick<SealDocumentDto, 'documentId'>,
    response: SealDocumentResponse,
  ): DeepPartial<SealEntity> {
    return {
      // `documentId` sale del DTO, no de la respuesta: es NUESTRO identificador y la FK de la
      // tabla — si el proveedor devolviera otro (o ninguno), la evidencia quedaría colgada de un
      // documento equivocado.
      documentId: dto.documentId,
      signatureHash: response.hashHex,
      /**
       * El XML canónico que devolvió el proveedor: la preimagen literal de `hashHex`. Con él
       * guardado, verificar el sello no requiere reimplementar la canonicalización de Seal Service
       * ni conservar el request original — basta recomputar `sha256(canonicalPayload)` y comparar
       * contra `signature_hash`.
       *
       * **Se decodifica el Base64 en el que viaja.** Seal Service lo transporta codificado (su
       * propio contrato lo documenta como "XML canónico […] codificado en base64"), pero lo que
       * se hashea es el XML en claro: guardarlo tal como llega dejaba una columna cuyo `sha256`
       * NO reproduce `signature_hash`, rompiendo en silencio la verificación que este campo
       * existe para permitir. Decodificar aquí es además lo que hace que la descarga del XML
       * canónico entregue un archivo XML de verdad, sin transformarlo.
       *
       * Las ENTRADAS de ese XML tampoco se pierden: siguen en `collaborators.advanced_signature`
       * de este mismo documento, así que la evidencia se puede auditar de punta a punta.
       */
      canonicalPayload: SealMapper.decodeCanonicalXml(response.canonicalString),
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
      integrityEvidence: SealMapper.buildIntegrityEvidence(response),
    };
  }

  /**
   * Deja el XML canónico en claro, decodificando el Base64 en el que Seal Service lo transporta.
   *
   * Tolerante a propósito: si el valor no fuera Base64 —un proveedor más viejo que lo mandaba en
   * claro, o un cambio de contrato— se conserva tal cual en vez de guardar basura. Se comprueba
   * re-codificando: sólo un Base64 legítimo vuelve a producirse a sí mismo.
   */
  private static decodeCanonicalXml(canonicalString: string): string {
    if (!canonicalString) {
      return canonicalString;
    }

    const decoded = Buffer.from(canonicalString, 'base64').toString('utf-8');

    return Buffer.from(decoded, 'utf-8').toString('base64') === canonicalString
      ? decoded
      : canonicalString;
  }

  /**
   * `certificateSerialNumber`/`certificateIssuedAt` son best-effort: si `file` no trae un
   * certificado embebido reconocible (o no es el CMS esperado), la evidencia se guarda igual,
   * solo sin esos dos campos. La vista pública reintenta la extracción para evidencias que se
   * quedaron sin ellos (ver `GetPublicDocumentUseCase`).
   */
  private static buildIntegrityEvidence(
    response: SealDocumentResponse,
  ): IntegrityEvidence {
    const tsaCertificate = extractTsaCertificateInfo(response.nom151.file);

    return {
      isValid: response.nom151.status,
      processedHash: response.nom151.hashProcessed,
      fileBase64: response.nom151.file,
      evidenceId: response.nom151.uuid,
      issuedAt: response.sealedAt ? new Date(response.sealedAt) : null,
      certificatePdfBase64: response.nom151.pdfFile,
      ...(tsaCertificate && {
        certificateSerialNumber: tsaCertificate.serialNumber,
        certificateIssuedAt: tsaCertificate.issuedAt,
        ...(tsaCertificate.subjectCommonName && {
          certificateSubjectCommonName: tsaCertificate.subjectCommonName,
        }),
      }),
    };
  }
}

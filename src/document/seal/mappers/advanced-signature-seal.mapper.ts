import type { SignatureResult } from 'src/efirma/interfaces/signature-result.interface';

import type { SealDocumentDto } from '../dto/seal-document.dto';

/**
 * Traduce el resultado de `EfirmaService.firmar` (persistido tal cual en
 * `CollaboratorEntity.advancedSignature`) al contrato que espera Seal Service.
 *
 * Toda fecha pasa por `new Date(...)` antes de `.toISOString()` porque `advancedSignature` es
 * `jsonb`: el mismo campo llega como `Date` recién firmado y como string releído de la base, y el
 * proveedor canonicaliza las firmas por `signedAt`, así que las dos rutas deben dar el mismo texto.
 * `ocspEvidence` se omite entera cuando la firma no la trae, en vez de mandar un objeto a medias.
 *
 * Es la misma traducción que usaba `DocumentService.toSealSignature`, que ahora delega aquí: el
 * snapshot del trabajo de sellado y el sellado oportunista de la vista pública tienen que producir
 * exactamente el mismo payload.
 *
 * @param signature - Firma avanzada persistida.
 * @returns La firma con la forma de `SealDocumentDto.signatures[number]`.
 *
 * @example
 * ```ts
 * const sealSignature = toSealSignature(collaborator.advancedSignature);
 * ```
 */
export function toSealSignature(
  signature: SignatureResult,
): SealDocumentDto['signatures'][number] {
  const { ocspEvidence } = signature;

  return {
    signatureBase64: String(signature.signatureBase64),
    algorithm: signature.algorithm,
    signedAt: new Date(signature.signedAt).toISOString(),
    certificate: {
      rfc: signature.certificate.rfc,
      name: signature.certificate.name,
      issuer: signature.certificate.issuer,
      serialNumber: signature.certificate.serialNumber,
      certificateNumber: signature.certificate.certificateNumber,
      certificatePem: signature.certificate.certificatePem,
    },
    ...(ocspEvidence && {
      ocspEvidence: {
        status: ocspEvidence.status,
        verifiedAt: new Date(ocspEvidence.verifiedAt).toISOString(),
        ocspResponse: ocspEvidence.ocspResponse,
        ocspUrl: ocspEvidence.ocspUrl,
      },
    }),
  };
}

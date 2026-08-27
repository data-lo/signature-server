import { fromBER } from 'asn1js';
import { Certificate, ContentInfo, SignedData } from 'pkijs';

export interface TsaCertificateInfo {
  serialNumber: string;
  issuedAt: Date;
}

/**
 * Extrae el número de serie y `notBefore` del certificado del PSC embebido en la evidencia
 * NOM-151 (`integrityEvidence.fileBase64`): un CMS SignedData —el mismo envoltorio que un sello
 * de tiempo RFC 3161— cuyo campo `certificates` trae el certificado que firmó la evidencia.
 * Sigue el flujo Base64 → bytes → ASN.1 (la cadena hexadecimal intermedia es solo para
 * inspección manual con un parser ASN.1; decodificar a bytes ya da lo mismo que necesita
 * `fromBER`).
 *
 * Devuelve `null` ante cualquier estructura que no reconozca en vez de lanzar: una evidencia
 * histórica puede no traer el certificado embebido, o el archivo puede no ser el CMS esperado, y
 * eso no debe tumbar ni la creación del sello ni la vista pública — solo dejar el certificado sin
 * mostrar.
 */
export function extractTsaCertificateInfo(
  fileBase64: string,
): TsaCertificateInfo | null {
  try {
    const derBytes = Buffer.from(fileBase64, 'base64');
    if (derBytes.length === 0) {
      return null;
    }

    const { result: asn1, offset } = fromBER(derBytes);
    if (offset === -1) {
      return null;
    }

    const contentInfo = new ContentInfo({ schema: asn1 });
    if (contentInfo.contentType !== ContentInfo.SIGNED_DATA) {
      return null;
    }

    const signedData = new SignedData({ schema: contentInfo.content });
    const certificate = signedData.certificates?.[0];
    if (!(certificate instanceof Certificate)) {
      return null;
    }

    const serialNumber = Buffer.from(
      certificate.serialNumber.valueBlock.valueHexView,
    )
      .toString('hex')
      .toUpperCase();
    const issuedAt = certificate.notBefore.value;

    if (
      !serialNumber ||
      !(issuedAt instanceof Date) ||
      Number.isNaN(issuedAt.getTime())
    ) {
      return null;
    }

    return { serialNumber, issuedAt };
  } catch {
    return null;
  }
}

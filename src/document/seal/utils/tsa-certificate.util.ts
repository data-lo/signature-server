import { fromBER } from 'asn1js';
import { Certificate, ContentInfo, SignedData } from 'pkijs';

export interface TsaCertificateInfo {
  serialNumber: string;
  issuedAt: Date;
  /**
   * Nombre común (CN) de quien emitió el certificado: lo que la tabla NOM-151 de las hojas de
   * evidencia imprime como "Certificado (TSA)".
   *
   * Opcional porque un certificado puede no traer CN en su emisor —el DN admite otras
   * combinaciones de atributos— y eso no debe invalidar la serie ni la fecha, que son los datos
   * que sí se obtuvieron.
   */
  issuerCommonName?: string;
}

/** OID del atributo `commonName` dentro de un DN X.500. */
const COMMON_NAME_OID = '2.5.4.3';

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

    const issuerCommonName = extractCommonName(certificate);

    return {
      serialNumber,
      issuedAt,
      ...(issuerCommonName && { issuerCommonName }),
    };
  } catch {
    return null;
  }
}

/**
 * CN del emisor del certificado.
 *
 * Se busca el atributo por su OID y no por posición: el orden de los componentes de un DN no está
 * garantizado, así que tomar el primero daría el país o la organización según el PSC.
 *
 * Devuelve `undefined` —y nunca lanza— ante un DN sin CN o con un valor que no sea texto: el
 * renglón se queda sin llenar, que es preferible a perder también la serie y la fecha.
 */
function extractCommonName(certificate: Certificate): string | undefined {
  try {
    const commonName = certificate.issuer.typesAndValues.find(
      (attribute) => attribute.type === COMMON_NAME_OID,
    );

    const value = commonName?.value?.valueBlock?.value;

    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

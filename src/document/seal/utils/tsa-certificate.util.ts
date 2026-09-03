import { fromBER } from 'asn1js';
import { Certificate, ContentInfo, SignedData } from 'pkijs';

export interface TsaCertificateInfo {
  serialNumber: string;
  issuedAt: Date;
  /**
   * Nombre común (CN) del **titular** del certificado: la Autoridad de Sellado de Tiempo que emitió
   * la constancia, que es lo que la tabla NOM-151 imprime como "Certificado (TSA)".
   *
   * Sale del `subject` y no del `issuer`: en una evidencia real de PSC CODEX el subject es
   * «Autoridad CCMD de PSC CODEX TUL» —quien sella— mientras que el issuer es la CA raíz que
   * acredita al PSC, así que usar el issuer haría que la hoja nombrara a la Secretaría de Economía
   * como si hubiera sellado el documento.
   *
   * Opcional porque un DN puede no traer CN, y eso no debe invalidar la serie ni la fecha.
   */
  subjectCommonName?: string;
}

/** OID del atributo `commonName` dentro de un DN X.500. */
const COMMON_NAME_OID = '2.5.4.3';

/**
 * Extrae el número de serie y el `notBefore` del certificado del PSC embebido en la evidencia
 * NOM-151: un CMS SignedData —el mismo envoltorio que un sello de tiempo RFC 3161— cuyo campo
 * `certificates` trae el certificado que la firmó. Va de Base64 a bytes y de ahí a ASN.1; la cadena
 * hexadecimal intermedia existe sólo para inspección manual.
 *
 * Devuelve `null` ante cualquier estructura que no reconozca, en vez de lanzar: una evidencia
 * histórica puede no traer el certificado embebido, y eso no debe tumbar ni la creación del sello ni
 * la vista pública, sólo dejar el certificado sin mostrar.
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

    const contentInfo = toSignedDataContentInfo(asn1);
    if (!contentInfo) {
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

    const subjectCommonName = extractCommonName(certificate);

    return {
      serialNumber,
      issuedAt,
      ...(subjectCommonName && { subjectCommonName }),
    };
  } catch {
    return null;
  }
}

/**
 * Localiza el `ContentInfo` de tipo SignedData dentro de la evidencia, venga desnudo o envuelto.
 *
 * **Los PSC no entregan todos la misma envoltura**: PSC CODEX responde un `TimeStampResp` de RFC
 * 3161 —`SEQUENCE { PKIStatusInfo, TimeStampToken }`—, donde el CMS es el SEGUNDO elemento, mientras
 * que otras evidencias llegan como el `ContentInfo` a secas. Asumir sólo lo segundo hacía que la
 * extracción devolviera `null` contra la evidencia real de producción y que la tabla NOM-151 saliera
 * vacía: el certificado estaba ahí, un nivel más abajo.
 *
 * Prueba primero la forma desnuda y después la envuelta en vez de inspeccionar la estructura:
 * `ContentInfo` ya valida el esquema y lanza si no encaja, así que probar es más fiable que
 * reimplementar esa comprobación.
 */
function toSignedDataContentInfo(asn1: unknown): ContentInfo | null {
  const candidates = [asn1, ...childrenOf(asn1)];

  for (const candidate of candidates) {
    try {
      const contentInfo = new ContentInfo({ schema: candidate });
      if (contentInfo.contentType === ContentInfo.SIGNED_DATA) {
        return contentInfo;
      }
    } catch {
      // No es un ContentInfo: se prueba el siguiente candidato.
    }
  }

  return null;
}

/** Hijos directos de un bloque ASN.1 constructivo; vacío si no los tiene. */
function childrenOf(asn1: unknown): unknown[] {
  const value = (asn1 as { valueBlock?: { value?: unknown[] } })?.valueBlock
    ?.value;

  return Array.isArray(value) ? value : [];
}

/**
 * Extrae el CN del titular (`subject`) del certificado: la autoridad que selló.
 *
 * Se busca el atributo por su OID y no por posición: el orden de los componentes de un DN no está
 * garantizado, así que tomar el primero daría el país o la organización según el PSC.
 *
 * Devuelve `undefined` —y nunca lanza— ante un DN sin CN o con un valor que no sea texto: el
 * renglón se queda sin llenar, que es preferible a perder también la serie y la fecha.
 */
function extractCommonName(certificate: Certificate): string | undefined {
  try {
    const commonName = certificate.subject.typesAndValues.find(
      (attribute) => attribute.type === COMMON_NAME_OID,
    );

    const value = commonName?.value?.valueBlock?.value;

    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

import { escapeXml } from '../utils/xml.util';
import type {
  AuditXmlDocumentFile,
  AuditXmlSeal,
  AuditXmlSigner,
  DocumentAuditXmlData,
} from './audit-xml.types';

/**
 * Serialización del XML de auditoría de un documento (historia "Habilitar descarga dinámica de XML
 * de auditoría en la vista pública").
 *
 * Es una función pura: recibe la evidencia ya resuelta y devuelve el texto del archivo. No consulta
 * la base ni MinIO, y nada de lo que produce se guarda — el XML existe sólo mientras dura la
 * respuesta HTTP (ver `GetPublicDocumentAuditXmlUseCase`).
 *
 * **Una pieza ausente se declara, no se omite.** Un expediente de auditoría al que le falta algo
 * tiene que decir qué le falta: quien lo revise no puede distinguir "no existe" de "se nos olvidó"
 * si el nodo simplemente no está. Por eso los archivos y las rúbricas que no se pudieron leer
 * viajan con `available="false"` y su motivo, en vez de desaparecer.
 */

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/** Versión del formato. Sube si cambian nombres de nodos o su significado, no si se agregan. */
const AUDIT_XML_VERSION = '1';

const INDENT = '  ';

type XmlAttributes = Record<
  string,
  string | number | boolean | null | undefined
>;

interface XmlNode {
  name: string;
  attributes?: XmlAttributes;
  /**
   * Contenido de texto. Excluyente con `children`; vacío o `null` produce un nodo cerrado en sí
   * mismo, que es como se representa "este campo existe y no tiene valor".
   */
  text?: string | null;
  children?: XmlNode[];
}

/** Nombre de elemento XML válido, con el subconjunto de caracteres que realmente emitimos. */
const VALID_XML_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;

export function buildDocumentAuditXml(data: DocumentAuditXmlData): string {
  const root: XmlNode = {
    name: 'documentAudit',
    attributes: {
      version: AUDIT_XML_VERSION,
      documentId: data.document.id,
      generatedAt: data.generatedAt,
    },
    children: [
      documentNode(data),
      { name: 'files', children: data.files.map(fileNode) },
      sealNode(data.seal),
      { name: 'signers', children: data.signers.map(signerNode) },
    ],
  };

  return [XML_DECLARATION, ...renderNode(root), ''].join('\n');
}

function documentNode(data: DocumentAuditXmlData): XmlNode {
  const { document } = data;

  return {
    name: 'document',
    attributes: { id: document.id },
    children: [
      { name: 'fileName', text: document.fileName },
      { name: 'mimeType', text: document.mimeType },
      { name: 'status', text: document.status },
      {
        name: 'totalPages',
        text: document.totalPages === null ? null : String(document.totalPages),
      },
      { name: 'signedAt', text: document.signedAt },
      { name: 'originalHash', text: document.originalHash },
      { name: 'signedHash', text: document.signedHash },
    ],
  };
}

/**
 * Un PDF del expediente en Base64, con el bucket y la llave de las que salió.
 *
 * `bucket` y `objectKey` no son adorno: son lo que permite a quien audite volver al almacenamiento
 * y comprobar que el archivo incluido es exactamente el que está guardado.
 */
function fileNode(file: AuditXmlDocumentFile): XmlNode {
  const available = file.contentBase64 !== null;

  return {
    name: 'file',
    attributes: {
      role: file.role,
      bucket: file.bucket,
      objectKey: file.objectKey,
      mimeType: file.mimeType,
      encoding: 'base64',
      available,
      unavailableReason: available ? undefined : file.unavailableReason,
    },
    text: file.contentBase64,
  };
}

function sealNode(seal: AuditXmlSeal | null): XmlNode {
  if (!seal) {
    // Sólo se sellan ante el PSC los documentos de firma avanzada, y el sellado es best-effort: un
    // documento sin constancia es normal, no un error.
    return {
      name: 'seal',
      attributes: {
        available: false,
        unavailableReason: 'El documento no tiene constancia de conservación.',
      },
    };
  }

  return {
    name: 'seal',
    attributes: { available: true },
    children: [
      { name: 'signatureHash', text: seal.signatureHash },
      { name: 'sealedAt', text: seal.sealedAt },
      /*
       * La cadena canónica va como TEXTO UTF-8 escapado, nunca como Base64 ni como XML anidado:
       * es la preimagen literal de `signatureHash`, y cualquier recodificación la volvería
       * inservible para recomputar el hash (ver `SEAL_ARTIFACT_ENUM.CANONICAL`). Para verificarla
       * hay que desescapar el contenido del nodo y sacarle sha256.
       */
      {
        name: 'canonicalPayload',
        attributes: { encoding: 'utf-8', hashAlgorithm: 'sha256' },
        text: seal.canonicalPayload,
      },
      {
        name: 'timestampEvidence',
        attributes: {
          encoding: 'base64',
          mimeType: 'application/timestamp-reply',
        },
        text: seal.timestampEvidenceBase64,
      },
      {
        name: 'nom151Evidence',
        attributes: { encoding: 'base64' },
        text: seal.nom151EvidenceBase64,
      },
      {
        name: 'nom151Certificate',
        attributes: { encoding: 'base64', mimeType: 'application/pdf' },
        text: seal.nom151CertificatePdfBase64,
      },
    ],
  };
}

function signerNode(signer: AuditXmlSigner): XmlNode {
  const children: XmlNode[] = [
    { name: 'email', text: signer.email },
    { name: 'curp', text: signer.curp },
    { name: 'signedAt', text: signer.signedAt },
    { name: 'signatureType', text: signer.signatureType },
    { name: 'status', text: signer.status },
    { name: 'ipAddress', text: signer.ipAddress },
    geoLocationNode(signer),
  ];

  if (signer.advancedSignature) {
    children.push({
      name: 'advancedSignature',
      children: jsonToXmlNodes(signer.advancedSignature),
    });
  }

  if (signer.simpleSignature) {
    children.push(simpleSignatureNode(signer));
  }

  return { name: 'signer', attributes: { id: signer.id }, children };
}

function simpleSignatureNode(signer: AuditXmlSigner): XmlNode {
  const { imageBase64, objectKey, unavailableReason } =
    signer.simpleSignature as NonNullable<AuditXmlSigner['simpleSignature']>;
  const available = imageBase64 !== null;

  return {
    name: 'simpleSignature',
    children: [
      {
        name: 'signatureImage',
        attributes: {
          encoding: 'base64',
          mimeType: 'image/png',
          objectKey,
          available,
          unavailableReason: available ? undefined : unavailableReason,
        },
        text: imageBase64,
      },
    ],
  };
}

/**
 * Ubicación declarada por el dispositivo del firmante al firmar. Cuando no existe se emite vacía
 * en vez de omitirse, por lo mismo que el resto: "no se capturó" es un dato de la auditoría.
 */
function geoLocationNode(signer: AuditXmlSigner): XmlNode {
  const geo = signer.geoLocation;

  if (!geo) {
    return { name: 'geoLocation', attributes: { available: false } };
  }

  return {
    name: 'geoLocation',
    attributes: {
      available: true,
      latitude: geo.latitude,
      longitude: geo.longitude,
      accuracy: geo.accuracy,
    },
  };
}

/**
 * Serializa un objeto JSON arbitrario —hoy `collaborators.advanced_signature`— como nodos XML.
 *
 * Genérico a propósito: la historia pide "todos los campos disponibles" de esa columna, y
 * escribirlos uno por uno dejaría fuera en silencio cualquier campo que el firmado agregue
 * después. Como es un jsonb y su forma la decide quien escribe la firma, los nombres de campo se
 * validan antes de usarse como nombre de elemento.
 */
function jsonToXmlNodes(value: Record<string, unknown>): XmlNode[] {
  return Object.entries(value).map(([key, entry]) => jsonToXmlNode(key, entry));
}

function jsonToXmlNode(key: string, value: unknown): XmlNode {
  // Un nombre que no sea un identificador XML válido tumbaría el archivo entero, así que se
  // degrada a `<field name="...">` en vez de emitirse crudo. No pasa con la forma actual de la
  // columna; existe porque el contenido de un jsonb no lo garantiza nadie.
  const named: Pick<XmlNode, 'name' | 'attributes'> = VALID_XML_NAME.test(key)
    ? { name: key }
    : { name: 'field', attributes: { name: key } };

  if (value === null || value === undefined) {
    return { ...named, attributes: { ...named.attributes, nil: true } };
  }

  if (value instanceof Date) {
    return { ...named, text: value.toISOString() };
  }

  if (Array.isArray(value)) {
    return {
      ...named,
      children: value.map((item) => jsonToXmlNode('item', item)),
    };
  }

  if (typeof value === 'object') {
    return {
      ...named,
      children: jsonToXmlNodes(value as Record<string, unknown>),
    };
  }

  return { ...named, text: String(value) };
}

function renderNode(node: XmlNode, indent = ''): string[] {
  const open = `${indent}<${node.name}${renderAttributes(node.attributes)}`;

  if (node.text !== undefined && node.text !== null && node.text !== '') {
    return [`${open}>${escapeXml(node.text)}</${node.name}>`];
  }

  const children = node.children ?? [];

  if (children.length === 0) {
    return [`${open} />`];
  }

  return [
    `${open}>`,
    ...children.flatMap((child) => renderNode(child, indent + INDENT)),
    `${indent}</${node.name}>`,
  ];
}

function renderAttributes(attributes: XmlAttributes | undefined): string {
  if (!attributes) {
    return '';
  }

  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => ` ${name}="${escapeXml(String(value))}"`)
    .join('');
}

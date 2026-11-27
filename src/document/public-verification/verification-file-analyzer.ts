import { createHash, type Hash } from 'crypto';
import { extname } from 'path';
import { StringDecoder } from 'string_decoder';

import { isUUID } from 'class-validator';
import * as sax from 'sax';

import {
  MAX_VERIFICATION_PDF_BYTES,
  MAX_VERIFICATION_XML_BYTES,
  VERIFICATION_ARTIFACT_TYPE_ENUM,
} from './public-verification.types';

/** Por qué no se puede verificar un archivo. */
export enum VERIFICATION_FILE_PROBLEM_ENUM {
  /** Extensión o tipo MIME que no es XML ni PDF. */
  UNSUPPORTED = 'UNSUPPORTED',
  /** Dice ser XML/PDF pero el contenido no lo es, está vacío, es demasiado grande o es XML inseguro. */
  INVALID = 'INVALID',
}

/** Resultado del análisis de un archivo, sin nada de su contenido salvo el hash y el id. */
export type VerificationFileAnalysis =
  | {
      ok: true;
      artifactType: VERIFICATION_ARTIFACT_TYPE_ENUM;
      /** SHA-256 hex de los bytes originales. */
      digest: string;
      /** Sólo XML: `documentId` de la raíz, ya validado como UUID. */
      documentId: string | null;
    }
  | { ok: false; problem: VERIFICATION_FILE_PROBLEM_ENUM; reason: string };

const EXTENSION_TYPES: Record<string, VERIFICATION_ARTIFACT_TYPE_ENUM> = {
  '.xml': VERIFICATION_ARTIFACT_TYPE_ENUM.AUDIT_XML,
  '.pdf': VERIFICATION_ARTIFACT_TYPE_ENUM.FINAL_DOCUMENT,
};

/**
 * Tipos MIME declarados aceptables por artefacto. `application/octet-stream` y vacío se toleran
 * porque muchos clientes no saben el tipo; lo que manda es el contenido (ver `checkSignature`).
 */
const ALLOWED_MIME_TYPES: Record<VERIFICATION_ARTIFACT_TYPE_ENUM, string[]> = {
  [VERIFICATION_ARTIFACT_TYPE_ENUM.AUDIT_XML]: [
    'application/xml',
    'text/xml',
    'application/octet-stream',
    '',
  ],
  [VERIFICATION_ARTIFACT_TYPE_ENUM.FINAL_DOCUMENT]: [
    'application/pdf',
    'application/octet-stream',
    '',
  ],
};

const MAX_BYTES: Record<VERIFICATION_ARTIFACT_TYPE_ENUM, number> = {
  [VERIFICATION_ARTIFACT_TYPE_ENUM.AUDIT_XML]: MAX_VERIFICATION_XML_BYTES,
  [VERIFICATION_ARTIFACT_TYPE_ENUM.FINAL_DOCUMENT]: MAX_VERIFICATION_PDF_BYTES,
};

/** Bytes del inicio que se miran para reconocer el contenido. */
const SIGNATURE_BYTES = 1024;

/**
 * Cuánto del XML se entrega al parser para encontrar la raíz. Nuestro XML la abre en la segunda
 * línea; no se parsea el resto (los PDFs en Base64), que sólo se hashea.
 */
const MAX_XML_HEADER_BYTES = 64 * 1024;

/** Raíz del XML de auditoría (ver `buildDocumentAuditXml`). */
const AUDIT_XML_ROOT = 'documentAudit';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/**
 * Analiza un archivo subido mientras llega, trozo a trozo, sin guardar su contenido:
 *
 * - Calcula el SHA-256 sobre los bytes ORIGINALES (nunca se reserializa nada).
 * - Decide el artefacto por la extensión y lo confirma por el contenido real: `%PDF-` al inicio
 *   para un PDF; un XML que empieza con `<` (tras un BOM o espacios opcionales). El tipo MIME
 *   declarado sólo puede descartar, nunca confirmar.
 * - Corta en cuanto se pasa del tope de su tipo.
 * - En un XML, extrae el `documentId` de la raíz con `sax` en modo estricto y SÓLO sobre los
 *   primeros 64 KB. Cualquier `<!DOCTYPE` (y con él toda declaración de entidades) invalida el
 *   archivo: `sax` no resuelve recursos externos ni expande entidades, y así tampoco hay DTD que
 *   interpretar.
 *
 * Lo único que retiene es el hash, el tamaño, los primeros bytes (hasta 1 KB) y, del XML, el
 * `documentId`.
 *
 * @example
 * ```ts
 * const analyzer = new VerificationFileAnalyzer({ originalName: 'auditoria.xml', mimeType: 'text/xml' });
 * for await (const chunk of stream) analyzer.write(chunk);
 * const analysis = analyzer.finish();
 * ```
 */
export class VerificationFileAnalyzer {
  private readonly artifactType: VERIFICATION_ARTIFACT_TYPE_ENUM | null;
  private readonly hash: Hash = createHash('sha256');
  private problem: {
    kind: VERIFICATION_FILE_PROBLEM_ENUM;
    reason: string;
  } | null = null;
  private size = 0;
  private head = Buffer.alloc(0);
  private signatureChecked = false;

  // Estado del parseo del encabezado XML.
  private readonly decoder = new StringDecoder('utf8');
  private xmlParser: sax.SAXParser | null = null;
  private xmlParsedBytes = 0;
  private documentId: string | null = null;

  /**
   * @param file - Nombre original y tipo MIME declarados por el cliente.
   */
  constructor(file: { originalName: string; mimeType: string | undefined }) {
    const extension = extname(file.originalName ?? '').toLowerCase();
    const artifactType = EXTENSION_TYPES[extension] ?? null;
    const mimeType = (file.mimeType ?? '').toLowerCase().split(';')[0].trim();

    if (!artifactType || !ALLOWED_MIME_TYPES[artifactType].includes(mimeType)) {
      this.artifactType = null;
      this.fail(
        VERIFICATION_FILE_PROBLEM_ENUM.UNSUPPORTED,
        'extensión o tipo MIME no admitido',
      );
      return;
    }

    this.artifactType = artifactType;
    if (artifactType === VERIFICATION_ARTIFACT_TYPE_ENUM.AUDIT_XML) {
      this.xmlParser = this.createXmlParser();
    }
  }

  /** `true` si ya no vale la pena seguir leyendo: el resultado ya está decidido. */
  get settled(): boolean {
    return this.problem !== null;
  }

  /**
   * Procesa el siguiente trozo del archivo.
   *
   * @param chunk - Bytes tal como llegaron.
   * @returns Nada.
   *
   * @example
   * ```ts
   * analyzer.write(chunk);
   * ```
   */
  write(chunk: Buffer): void {
    if (this.problem || !this.artifactType) return;

    this.size += chunk.length;
    if (this.size > MAX_BYTES[this.artifactType]) {
      this.fail(
        VERIFICATION_FILE_PROBLEM_ENUM.INVALID,
        'excede el tamaño máximo',
      );
      return;
    }

    this.hash.update(chunk);

    if (!this.signatureChecked) {
      this.head = Buffer.concat([this.head, chunk]).subarray(
        0,
        SIGNATURE_BYTES,
      );
      if (this.head.length >= SIGNATURE_BYTES) this.checkSignature();
      if (this.problem) return;
    }

    this.feedXmlHeader(chunk);
  }

  /**
   * Cierra el análisis.
   *
   * @returns El hash y el artefacto, o el problema que impide verificarlo.
   *
   * @example
   * ```ts
   * const analysis = analyzer.finish();
   * if (analysis.ok) lookup(analysis.digest);
   * ```
   */
  finish(): VerificationFileAnalysis {
    if (!this.problem && this.size === 0) {
      this.fail(VERIFICATION_FILE_PROBLEM_ENUM.INVALID, 'archivo vacío');
    }
    if (!this.problem && !this.signatureChecked) this.checkSignature();
    if (!this.problem && this.xmlParser) {
      // El encabezado terminó antes de abrir la raíz: XML truncado o sin raíz.
      this.fail(
        VERIFICATION_FILE_PROBLEM_ENUM.INVALID,
        'XML sin elemento raíz',
      );
    }

    if (this.problem) {
      return {
        ok: false,
        problem: this.problem.kind,
        reason: this.problem.reason,
      };
    }

    return {
      ok: true,
      artifactType: this.artifactType as VERIFICATION_ARTIFACT_TYPE_ENUM,
      digest: this.hash.digest('hex'),
      documentId: this.documentId,
    };
  }

  /** Confirma por el contenido que el archivo es lo que su extensión dice. */
  private checkSignature(): void {
    this.signatureChecked = true;

    if (this.artifactType === VERIFICATION_ARTIFACT_TYPE_ENUM.FINAL_DOCUMENT) {
      if (!this.head.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
        this.fail(VERIFICATION_FILE_PROBLEM_ENUM.INVALID, 'no es un PDF');
      }
      return;
    }

    let start = this.head.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
      ? UTF8_BOM.length
      : 0;
    while (
      start < this.head.length &&
      [0x20, 0x09, 0x0a, 0x0d].includes(this.head[start])
    ) {
      start++;
    }
    if (this.head[start] !== 0x3c /* '<' */) {
      this.fail(VERIFICATION_FILE_PROBLEM_ENUM.INVALID, 'no es un XML');
    }
  }

  /** Entrega al parser sólo lo necesario para leer la raíz. */
  private feedXmlHeader(chunk: Buffer): void {
    if (!this.xmlParser) return;

    const remaining = MAX_XML_HEADER_BYTES - this.xmlParsedBytes;
    const slice = chunk.subarray(0, remaining);
    this.xmlParsedBytes += slice.length;

    try {
      this.xmlParser.write(this.decoder.write(slice));
    } catch {
      this.fail(VERIFICATION_FILE_PROBLEM_ENUM.INVALID, 'XML mal formado');
      return;
    }

    if (this.xmlParser && this.xmlParsedBytes >= MAX_XML_HEADER_BYTES) {
      this.fail(
        VERIFICATION_FILE_PROBLEM_ENUM.INVALID,
        'XML sin raíz en el encabezado',
      );
    }
  }

  /**
   * Parser estricto que sólo mira hasta la raíz. Al abrirla deja de recibir datos (el resto del
   * archivo sólo se hashea), así que nunca acumula los nodos de texto en Base64.
   */
  private createXmlParser(): sax.SAXParser {
    const parser = sax.parser(true, { xmlns: false, position: false });
    // `sax` termina de procesar el trozo en curso aunque la raíz ya se haya leído: desde ahí los
    // eventos de los hijos (o de un cuerpo roto) se ignoran.
    let rootRead = false;

    parser.ondoctype = () => {
      if (!rootRead) throw new Error('DTD no permitida');
    };
    parser.onerror = (error) => {
      if (!rootRead) throw error;
    };
    parser.onopentag = (node) => {
      if (rootRead) return;
      rootRead = true;
      // Ya no se parsea nada más: el resto del archivo sólo se hashea.
      this.xmlParser = null;

      const attributes = node.attributes as Record<string, string>;
      const documentId = attributes.documentId;
      if (node.name !== AUDIT_XML_ROOT || !isUUID(documentId ?? '')) {
        this.fail(
          VERIFICATION_FILE_PROBLEM_ENUM.INVALID,
          'raíz sin documentId válido',
        );
        return;
      }
      this.documentId = documentId.toLowerCase();
    };

    return parser;
  }

  private fail(kind: VERIFICATION_FILE_PROBLEM_ENUM, reason: string): void {
    this.problem ??= { kind, reason };
    this.xmlParser = null;
  }
}

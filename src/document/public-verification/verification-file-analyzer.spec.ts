import { createHash, randomUUID } from 'crypto';

import { buildDocumentAuditXml } from '../audit-xml/audit-xml.builder';
import {
  MAX_VERIFICATION_PDF_BYTES,
  VERIFICATION_ARTIFACT_TYPE_ENUM,
} from './public-verification.types';
import {
  VERIFICATION_FILE_PROBLEM_ENUM,
  VerificationFileAnalyzer,
  type VerificationFileAnalysis,
} from './verification-file-analyzer';

const DOCUMENT_ID = randomUUID();

/** XML de auditoría real, tal como lo arma el backend. */
function auditXml(documentId = DOCUMENT_ID): string {
  return buildDocumentAuditXml({
    document: {
      id: documentId,
      fileName: 'contrato ñandú.pdf',
      mimeType: 'application/pdf',
      status: 'SIGNED',
      totalPages: 1,
      originalHash: 'a'.repeat(64),
      signedHash: 'b'.repeat(64),
      signedAt: '2026-11-19T12:00:00.000Z',
    },
    files: [
      {
        role: 'finalized',
        bucket: 'finalized_documents',
        objectKey: 'doc.pdf',
        mimeType: 'application/pdf',
        contentBase64: Buffer.from('%PDF-1.7 final').toString('base64'),
      },
    ],
    seal: null,
    signers: [],
  });
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Analiza `content` entregándolo en trozos de `chunkSize` bytes. */
function analyze(
  content: Buffer | string,
  file: { originalName: string; mimeType?: string },
  chunkSize = 16 * 1024,
): VerificationFileAnalysis {
  const bytes = Buffer.isBuffer(content)
    ? content
    : Buffer.from(content, 'utf8');
  const analyzer = new VerificationFileAnalyzer({
    originalName: file.originalName,
    mimeType: file.mimeType,
  });
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    if (analyzer.settled) break;
    analyzer.write(bytes.subarray(offset, offset + chunkSize));
  }
  return analyzer.finish();
}

const XML_FILE = { originalName: 'auditoria.xml', mimeType: 'application/xml' };
const PDF_FILE = { originalName: 'contrato.pdf', mimeType: 'application/pdf' };

function expectProblem(
  analysis: VerificationFileAnalysis,
  problem: VERIFICATION_FILE_PROBLEM_ENUM,
) {
  expect(analysis).toEqual(expect.objectContaining({ ok: false, problem }));
}

describe('VerificationFileAnalyzer', () => {
  describe('XML de auditoría', () => {
    it('calcula el SHA-256 de los bytes originales y extrae el documentId', () => {
      const xml = auditXml();

      expect(analyze(xml, XML_FILE)).toEqual({
        ok: true,
        artifactType: VERIFICATION_ARTIFACT_TYPE_ENUM.AUDIT_XML,
        digest: sha256(Buffer.from(xml, 'utf8')),
        documentId: DOCUMENT_ID,
      });
    });

    it('da el mismo resultado aunque llegue byte a byte (cortes dentro de caracteres UTF-8)', () => {
      const xml = auditXml();

      expect(analyze(xml, XML_FILE, 1)).toEqual(analyze(xml, XML_FILE));
    });

    it('hashea también el BOM: el digest es del archivo tal cual, sin reserializar', () => {
      const withBom = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(auditXml(), 'utf8'),
      ]);

      const analysis = analyze(withBom, XML_FILE);

      expect(analysis).toEqual(
        expect.objectContaining({ ok: true, digest: sha256(withBom) }),
      );
      expect(analysis).not.toEqual(
        expect.objectContaining({ digest: sha256(Buffer.from(auditXml())) }),
      );
    });

    it.each(['text/xml', 'application/octet-stream', undefined])(
      'acepta el tipo MIME %s',
      (mimeType) => {
        expect(
          analyze(auditXml(), { originalName: 'a.XML', mimeType }),
        ).toEqual(expect.objectContaining({ ok: true }));
      },
    );

    it('un byte distinto da otro digest con el mismo documentId', () => {
      const xml = auditXml();
      const tampered = xml.replace('contrato ñandú', 'contrato ñanDú');

      const original = analyze(xml, XML_FILE);
      const modified = analyze(tampered, XML_FILE);

      expect(modified).toEqual(
        expect.objectContaining({ ok: true, documentId: DOCUMENT_ID }),
      );
      expect((modified as { digest: string }).digest).not.toBe(
        (original as { digest: string }).digest,
      );
    });

    it('rechaza una DTD aunque no declare entidades', () => {
      const xml = auditXml().replace(
        '<documentAudit',
        '<!DOCTYPE documentAudit>\n<documentAudit',
      );

      expectProblem(
        analyze(xml, XML_FILE),
        VERIFICATION_FILE_PROBLEM_ENUM.INVALID,
      );
    });

    it('rechaza una entidad externa (XXE) sin resolverla', () => {
      const xml = `<?xml version="1.0"?>
<!DOCTYPE documentAudit [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<documentAudit version="1" documentId="${DOCUMENT_ID}">&xxe;</documentAudit>`;

      expectProblem(
        analyze(xml, XML_FILE),
        VERIFICATION_FILE_PROBLEM_ENUM.INVALID,
      );
    });

    it('rechaza la expansión de entidades (billion laughs)', () => {
      const xml = `<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]>
<documentAudit documentId="${DOCUMENT_ID}">&lol2;</documentAudit>`;

      expectProblem(
        analyze(xml, XML_FILE),
        VERIFICATION_FILE_PROBLEM_ENUM.INVALID,
      );
    });

    it.each([
      ['no es XML', 'esto no es un xml'],
      ['raíz mal formada', `<documentAudit documentId="${DOCUMENT_ID}`],
      ['atributo sin comillas', `<documentAudit documentId=${DOCUMENT_ID}>`],
      ['otra raíz', `<invoice documentId="${DOCUMENT_ID}"></invoice>`],
      ['sin documentId', '<documentAudit version="1"></documentAudit>'],
      [
        'documentId que no es UUID',
        '<documentAudit documentId="1 OR 1=1"></documentAudit>',
      ],
      ['vacío', ''],
    ])('XML inválido: %s', (_, xml) => {
      expectProblem(
        analyze(xml, XML_FILE),
        VERIFICATION_FILE_PROBLEM_ENUM.INVALID,
      );
    });

    it('rechaza un XML cuya raíz no aparece en los primeros 64 KB', () => {
      const xml = `<!--${'x'.repeat(70 * 1024)}-->\n${auditXml()}`;

      expectProblem(
        analyze(xml, XML_FILE),
        VERIFICATION_FILE_PROBLEM_ENUM.INVALID,
      );
    });

    it('no parsea más allá de la raíz: el resto sólo se hashea', () => {
      // Cuerpo roto después de la raíz: si el hash no coincide, el resultado será COMPROMISED.
      const xml = `${auditXml().split('\n').slice(0, 2).join('\n')}\n<files><<<roto`;

      expect(analyze(xml, XML_FILE)).toEqual(
        expect.objectContaining({ ok: true, documentId: DOCUMENT_ID }),
      );
    });
  });

  describe('PDF final', () => {
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.alloc(4096, 7),
    ]);

    it('calcula el SHA-256 de los bytes originales', () => {
      expect(analyze(pdf, PDF_FILE, 100)).toEqual({
        ok: true,
        artifactType: VERIFICATION_ARTIFACT_TYPE_ENUM.FINAL_DOCUMENT,
        digest: sha256(pdf),
        documentId: null,
      });
    });

    it('rechaza un .pdf cuyo contenido no es PDF', () => {
      expectProblem(
        analyze(Buffer.from('<html>no soy un pdf</html>'), PDF_FILE),
        VERIFICATION_FILE_PROBLEM_ENUM.INVALID,
      );
    });

    it('rechaza un PDF que excede el tope', () => {
      const big = Buffer.concat([
        Buffer.from('%PDF-1.7\n'),
        Buffer.alloc(MAX_VERIFICATION_PDF_BYTES),
      ]);

      expectProblem(
        analyze(big, PDF_FILE, 1024 * 1024),
        VERIFICATION_FILE_PROBLEM_ENUM.INVALID,
      );
    });
  });

  describe('tipo no admitido', () => {
    it.each([
      [
        'un Word',
        { originalName: 'contrato.docx', mimeType: 'application/octet-stream' },
      ],
      [
        'sin extensión',
        { originalName: 'contrato', mimeType: 'application/pdf' },
      ],
      [
        'un .pdf declarado como imagen',
        { originalName: 'contrato.pdf', mimeType: 'image/png' },
      ],
      [
        'un .xml declarado como PDF',
        { originalName: 'a.xml', mimeType: 'application/pdf' },
      ],
    ])('%s', (_, file) => {
      expectProblem(
        analyze(Buffer.from('%PDF-1.7'), file),
        VERIFICATION_FILE_PROBLEM_ENUM.UNSUPPORTED,
      );
    });

    it('decide sin leer el contenido', () => {
      const analyzer = new VerificationFileAnalyzer({
        originalName: 'foto.png',
        mimeType: 'image/png',
      });

      expect(analyzer.settled).toBe(true);
    });
  });
});

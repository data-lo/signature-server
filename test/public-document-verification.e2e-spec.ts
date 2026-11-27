import { createHash, randomUUID } from 'crypto';

import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import * as request from 'supertest';

import { buildDocumentAuditXml } from './../src/document/audit-xml/audit-xml.builder';
import { DocumentEntity } from './../src/document/entities/document.entity';
import { PublicDocumentVerificationController } from './../src/document/public-verification/public-document-verification.controller';
import {
  MAX_VERIFICATION_PDF_BYTES,
  VERIFICATION_MESSAGES,
} from './../src/document/public-verification/public-verification.types';
import { VerifyPublicDocumentUseCase } from './../src/document/public-verification/verify-public-document.use-case';
import { SealingTestDatabase } from './fixtures/sealing/sealing-test-database';

const sha256 = (content: Buffer | string) =>
  createHash('sha256').update(content).digest('hex');

/** Marca que va dentro de cada archivo subido: nunca debe aparecer en un log. */
const CONTENT_MARKER = 'CONTENIDO-PRIVADO-DEL-ARCHIVO';

/**
 * `POST /document/public/verify` de punta a punta: multipart real por HTTP, el motor de
 * almacenamiento en streaming, el analizador y las consultas contra Postgres (base aislada con
 * todas las migraciones, incluidos los índices de los digests).
 */
describe('Verificación pública por archivo (e2e)', () => {
  const db = new SealingTestDatabase('signature_public_verify_e2e');
  let app: INestApplication;
  let logged: string[];

  beforeAll(async () => {
    await db.create();
  }, 120_000);

  afterAll(async () => {
    await db.destroy();
  });

  // Una app por prueba: el rate limiting (10/min por IP) se cuenta por instancia.
  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 10 }] }),
      ],
      controllers: [PublicDocumentVerificationController],
      providers: [
        VerifyPublicDocumentUseCase,
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: db.dataSource.getRepository(DocumentEntity),
        },
      ],
    }).compile();

    logged = [];
    const capture = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    for (const method of [
      'log',
      'error',
      'warn',
      'debug',
      'verbose',
    ] as const) {
      jest.spyOn(Logger.prototype, method).mockImplementation(capture);
    }
    for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      jest.spyOn(console, method).mockImplementation(capture);
    }

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    // Nada del archivo en ningún log, en ninguna prueba.
    expect(logged.join('\n')).not.toContain(CONTENT_MARKER);
    await app.close();
    jest.restoreAllMocks();
  });

  function auditXmlFor(documentId: string): string {
    return buildDocumentAuditXml({
      document: {
        id: documentId,
        fileName: `${CONTENT_MARKER}.pdf`,
        mimeType: 'application/pdf',
        status: 'SIGNED',
        totalPages: 1,
        originalHash: 'a'.repeat(64),
        signedHash: 'b'.repeat(64),
        signedAt: '2026-11-19T12:00:00.000Z',
      },
      files: [],
      seal: null,
      signers: [],
    });
  }

  function finalPdf(): Buffer {
    return Buffer.from(`%PDF-1.7\n${CONTENT_MARKER} ${randomUUID()}\n%%EOF`);
  }

  /** Documento firmado con sus dos huellas registradas, como al completar el sellado. */
  async function sealedDocument() {
    const documentId = await db.insertDocument({ sealingPending: false });
    const xml = auditXmlFor(documentId);
    const pdf = finalPdf();
    await db.dataSource.query(
      // `signed_at` es `timestamp` sin zona: se pasa un Date, como lo escribe TypeORM al firmar.
      `UPDATE documents SET final_document_digest = $2, signed_at = $3 WHERE id = $1`,
      [documentId, sha256(pdf), new Date('2026-11-19T12:00:00.000Z')],
    );
    await db.dataSource.query(
      `INSERT INTO document_seals (document_id, signature_hash, canonical_payload, timestamp_evidence, integrity_evidence, verification_record_digest)
       VALUES ($1, 'hash', 'cadena', '{}', '{}', $2)`,
      [documentId, sha256(xml)],
    );
    return { documentId, xml, pdf };
  }

  const verify = () =>
    request(app.getHttpServer()).post('/document/public/verify');

  function attach(
    content: Buffer | string,
    filename: string,
    contentType: string,
  ) {
    return verify().attach(
      'file',
      Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
      { filename, contentType },
    );
  }

  it('XML cuyo SHA-256 coincide → VALID con el documento', async () => {
    const { documentId, xml } = await sealedDocument();

    const response = await attach(xml, 'auditoria.xml', 'application/xml');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      message: VERIFICATION_MESSAGES.VALID,
      data: {
        status: 'VALID',
        artifactType: 'AUDIT_XML',
        message: VERIFICATION_MESSAGES.VALID,
        document: {
          id: documentId,
          fileName: 'contrato.pdf',
          signedAt: '2026-11-19T12:00:00.000Z',
        },
      },
    });
  });

  it('PDF final cuyo SHA-256 coincide → VALID', async () => {
    const { documentId, pdf } = await sealedDocument();

    const response = await attach(pdf, 'final.pdf', 'application/pdf');

    expect(response.body.data).toEqual(
      expect.objectContaining({
        status: 'VALID',
        artifactType: 'FINAL_DOCUMENT',
        document: expect.objectContaining({ id: documentId }),
      }),
    );
  });

  it('XML modificado con documentId existente → COMPROMISED, sin datos del documento', async () => {
    const { xml } = await sealedDocument();
    const tampered = xml.replace(
      '<status>SIGNED</status>',
      '<status>SIGNEd</status>',
    );

    const response = await attach(tampered, 'auditoria.xml', 'text/xml');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      status: 'COMPROMISED',
      artifactType: 'AUDIT_XML',
      message: VERIFICATION_MESSAGES.COMPROMISED,
    });
  });

  it('XML de un documento sellado sin huella registrada → NOT_FOUND, no COMPROMISED', async () => {
    const documentId = await db.insertDocument({ sealingPending: false });
    await db.dataSource.query(
      `INSERT INTO document_seals (document_id, signature_hash, canonical_payload, timestamp_evidence, integrity_evidence)
       VALUES ($1, 'hash', 'cadena', '{}', '{}')`,
      [documentId],
    );

    const response = await attach(
      auditXmlFor(documentId),
      'auditoria.xml',
      'application/xml',
    );

    expect(response.body.data.status).toBe('NOT_FOUND');
  });

  it('XML con documentId inexistente → NOT_FOUND', async () => {
    const response = await attach(
      auditXmlFor(randomUUID()),
      'auditoria.xml',
      'application/xml',
    );

    expect(response.body.data).toEqual({
      status: 'NOT_FOUND',
      artifactType: 'AUDIT_XML',
      message: VERIFICATION_MESSAGES.NOT_FOUND,
    });
  });

  it('PDF sin hash registrado → NOT_FOUND', async () => {
    await sealedDocument();

    const response = await attach(finalPdf(), 'final.pdf', 'application/pdf');

    expect(response.body.data).toEqual({
      status: 'NOT_FOUND',
      artifactType: 'FINAL_DOCUMENT',
      message: VERIFICATION_MESSAGES.NOT_FOUND,
    });
  });

  it.each([
    [
      'con entidad externa (XXE)',
      `<?xml version="1.0"?><!DOCTYPE documentAudit [<!ENTITY x SYSTEM "file:///etc/passwd">]><documentAudit documentId="${randomUUID()}">&x;</documentAudit>`,
    ],
    ['mal formado', `<documentAudit documentId="${randomUUID()}`],
    [
      'sin UUID válido',
      '<documentAudit documentId="no-es-uuid"></documentAudit>',
    ],
  ])('XML %s → INVALID_FILE', async (_, xml) => {
    const response = await attach(
      `${xml}<!--${CONTENT_MARKER}-->`,
      'auditoria.xml',
      'application/xml',
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      status: 'INVALID_FILE',
      message: VERIFICATION_MESSAGES.INVALID_FILE,
    });
  });

  it('un .pdf que no es PDF → INVALID_FILE', async () => {
    const response = await attach(
      `<html>${CONTENT_MARKER}</html>`,
      'final.pdf',
      'application/pdf',
    );

    expect(response.body.data.status).toBe('INVALID_FILE');
  });

  it('un PDF que excede el tope → INVALID_FILE', async () => {
    const big = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.alloc(MAX_VERIFICATION_PDF_BYTES),
    ]);

    const response = await attach(big, 'final.pdf', 'application/pdf');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('INVALID_FILE');
  });

  it.each([
    [
      'un Word',
      'contrato.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    ['un PDF declarado como imagen', 'final.pdf', 'image/png'],
  ])('%s → UNSUPPORTED_FILE', async (_, filename, contentType) => {
    const response = await attach(
      `%PDF-1.7 ${CONTENT_MARKER}`,
      filename,
      contentType,
    );

    expect(response.body.data).toEqual({
      status: 'UNSUPPORTED_FILE',
      message: VERIFICATION_MESSAGES.UNSUPPORTED_FILE,
    });
  });

  it('sin archivo → UNSUPPORTED_FILE', async () => {
    const response = await verify();

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('UNSUPPORTED_FILE');
  });

  it('dos archivos → UNSUPPORTED_FILE', async () => {
    const { pdf } = await sealedDocument();

    const response = await verify()
      .attach('file', pdf, {
        filename: 'a.pdf',
        contentType: 'application/pdf',
      })
      .attach('file', pdf, {
        filename: 'b.pdf',
        contentType: 'application/pdf',
      });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('UNSUPPORTED_FILE');
  });

  it('el archivo en otro campo → UNSUPPORTED_FILE', async () => {
    const response = await verify().attach('documento', finalPdf(), {
      filename: 'final.pdf',
      contentType: 'application/pdf',
    });

    expect(response.body.data.status).toBe('UNSUPPORTED_FILE');
  });

  it('limita a 10 verificaciones por minuto por IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (await attach(finalPdf(), 'final.pdf', 'application/pdf')).status,
      );
    }

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
  });
});

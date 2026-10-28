import { buildDocumentAuditXml } from './audit-xml.builder';
import type { DocumentAuditXmlData } from './audit-xml.types';

/**
 * Estas pruebas miran el TEXTO del archivo, no un objeto intermedio: lo que se entrega como
 * evidencia es el XML, y un error de escapado o una pieza omitida sólo se ven ahí.
 */
function buildData(
  overrides: Partial<DocumentAuditXmlData> = {},
): DocumentAuditXmlData {
  return {
    generatedAt: '2026-01-15T10:00:00.000Z',
    document: {
      id: 'doc-1',
      fileName: 'contrato.pdf',
      mimeType: 'application/pdf',
      status: 'signed',
      totalPages: 3,
      originalHash: 'hash-original',
      signedHash: 'hash-firmado',
      signedAt: '2026-01-14T09:00:00.000Z',
    },
    files: [
      {
        role: 'original',
        bucket: 'created_documents',
        objectKey: 'key.pdf',
        mimeType: 'application/pdf',
        contentBase64: 'T1JJR0lOQUw=',
      },
      {
        role: 'signed',
        bucket: 'signed_documents',
        objectKey: 'key.pdf',
        mimeType: 'application/pdf',
        contentBase64: 'RklSTUFETw==',
      },
    ],
    seal: null,
    signers: [],
    ...overrides,
  };
}

/** Extrae el contenido de un nodo simple, para afirmar sobre el valor y no sobre el formato. */
function nodeText(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
  return match ? match[1] : null;
}

describe('buildDocumentAuditXml', () => {
  it('abre con la declaración XML y describe el documento', () => {
    const xml = buildDocumentAuditXml(buildData());

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(
      true,
    );
    expect(xml).toContain('<documentAudit version="1" documentId="doc-1"');
    expect(nodeText(xml, 'fileName')).toBe('contrato.pdf');
    expect(nodeText(xml, 'mimeType')).toBe('application/pdf');
    expect(nodeText(xml, 'originalHash')).toBe('hash-original');
    expect(nodeText(xml, 'signedHash')).toBe('hash-firmado');
  });

  it('incluye cada PDF en Base64 con el bucket del que salió', () => {
    const xml = buildDocumentAuditXml(
      buildData({
        files: [
          {
            role: 'original',
            bucket: 'created_documents',
            objectKey: 'key.pdf',
            mimeType: 'application/pdf',
            contentBase64: 'T1JJR0lOQUw=',
          },
          {
            role: 'signed',
            bucket: 'signed_documents',
            objectKey: 'key.pdf',
            mimeType: 'application/pdf',
            contentBase64: 'RklSTUFETw==',
          },
          {
            role: 'finalized',
            bucket: 'finalized_documents',
            objectKey: 'key.pdf',
            mimeType: 'application/pdf',
            contentBase64: 'RklOQUw=',
          },
        ],
      }),
    );

    expect(xml).toContain(
      '<file role="original" bucket="created_documents" objectKey="key.pdf" mimeType="application/pdf" encoding="base64" available="true">T1JJR0lOQUw=</file>',
    );
    expect(xml).toContain('>RklSTUFETw==</file>');
    expect(xml).toContain('>RklOQUw=</file>');
  });

  /**
   * El caso que justifica todo el criterio de "declarar, no omitir": si el PDF definitivo no
   * estuviera y su nodo desapareciera, el expediente se leería como si ese archivo no existiera.
   */
  it('marca el archivo que no se pudo leer en vez de omitirlo', () => {
    const xml = buildDocumentAuditXml(
      buildData({
        files: [
          {
            role: 'finalized',
            bucket: 'finalized_documents',
            objectKey: 'key.pdf',
            mimeType: 'application/pdf',
            contentBase64: null,
            unavailableReason: 'El archivo no está disponible.',
          },
        ],
      }),
    );

    expect(xml).toContain('role="finalized"');
    expect(xml).toContain('available="false"');
    expect(xml).toContain('unavailableReason="El archivo no está disponible."');
  });

  it('escribe la cadena canónica como texto UTF-8 escapado, no como Base64', () => {
    const xml = buildDocumentAuditXml(
      buildData({
        seal: {
          signatureHash: 'hash-sello',
          canonicalPayload: '12|doc<uno> & "dos"||34|firma',
          timestampEvidenceBase64: 'VFNS',
          nom151EvidenceBase64: 'Tk9NMTUx',
          nom151CertificatePdfBase64: 'UERG',
          sealedAt: '2026-01-14T09:05:00.000Z',
        },
      }),
    );

    expect(xml).toContain(
      '<canonicalPayload encoding="utf-8" hashAlgorithm="sha256">12|doc&lt;uno&gt; &amp; &quot;dos&quot;||34|firma</canonicalPayload>',
    );
    expect(nodeText(xml, 'signatureHash')).toBe('hash-sello');
    expect(nodeText(xml, 'timestampEvidence')).toBe('VFNS');
    expect(nodeText(xml, 'nom151Evidence')).toBe('Tk9NMTUx');
  });

  it('declara el sello ausente cuando el documento no se selló', () => {
    const xml = buildDocumentAuditXml(buildData({ seal: null }));

    expect(xml).toContain('<seal available="false"');
    expect(xml).not.toContain('<canonicalPayload');
  });

  /**
   * `advanced_signature` es un jsonb: se serializa entero y no campo por campo, porque la historia
   * pide "todos los campos disponibles" y una lista fija dejaría fuera lo que se agregue después
   * —`ocspEvidence` es exactamente ese caso.
   */
  it('serializa todos los campos de advanced_signature, incluidos los anidados', () => {
    const xml = buildDocumentAuditXml(
      buildData({
        signers: [
          {
            id: 'col-1',
            email: 'firmante@example.com',
            curp: 'CURP000000HDFABC01',
            signedAt: '2026-01-14T08:00:00.000Z',
            signatureType: 'FIEL',
            status: 'SIGNED',
            ipAddress: '10.0.0.1',
            geoLocation: null,
            advancedSignature: {
              signatureBase64: 'RklSTUE=',
              algorithm: 'sha256',
              documentHash: 'hash-doc',
              signedAt: '2026-01-14T08:00:00.000Z',
              certificate: {
                rfc: 'AAA010101AAA',
                name: 'Juan & Pérez',
                serialNumber: '00001',
                certificatePem: '-----BEGIN CERTIFICATE-----',
              },
              ocspEvidence: { status: 'good', ocspUrl: 'http://ocsp' },
            },
            simpleSignature: null,
          },
        ],
      }),
    );

    expect(xml).toContain('<signer id="col-1">');
    expect(nodeText(xml, 'curp')).toBe('CURP000000HDFABC01');
    expect(nodeText(xml, 'signatureBase64')).toBe('RklSTUE=');
    expect(nodeText(xml, 'algorithm')).toBe('sha256');
    expect(nodeText(xml, 'documentHash')).toBe('hash-doc');
    // El nombre del certificado lleva un `&`: sin escapar, el archivo no abriría.
    expect(nodeText(xml, 'name')).toBe('Juan &amp; Pérez');
    expect(nodeText(xml, 'certificatePem')).toBe('-----BEGIN CERTIFICATE-----');
    expect(nodeText(xml, 'ocspUrl')).toBe('http://ocsp');
    expect(xml).not.toContain('<simpleSignature>');
    expect(xml).not.toContain('signatureMedia');
    expect(xml).not.toContain('identityDocument');
  });

  it('incluye la rúbrica PNG en Base64 del firmante de firma simple', () => {
    const xml = buildDocumentAuditXml(
      buildData({
        signers: [
          {
            id: 'col-2',
            email: 'simple@example.com',
            curp: 'CURP000000HDFABC02',
            signedAt: '2026-01-14T08:30:00.000Z',
            signatureType: 'SIMPLE',
            status: 'SIGNED',
            ipAddress: '10.0.0.2',
            geoLocation: { latitude: 19.43, longitude: -99.13, accuracy: 12 },
            advancedSignature: null,
            simpleSignature: {
              objectKey: 'rubrica.png',
              imageBase64: 'UE5H',
              identityDocumentFrontImage: {
                mimeType: 'image/jpeg',
                contentBase64: 'SU5FLUZSRU5URQ==',
              },
              identityDocumentBackImage: {
                mimeType: 'image/png',
                contentBase64: 'SU5FLVJFVkVSU08=',
              },
            },
          },
        ],
      }),
    );

    expect(xml).toContain('mimeType="image/png"');
    expect(xml).toContain('>UE5H</signatureImage>');
    expect(xml).toContain(
      '<geoLocation available="true" latitude="19.43" longitude="-99.13" accuracy="12" />',
    );
  });

  /**
   * La rúbrica y las dos caras de la INE viajan juntas dentro de `signatureMedia`, cada una con su
   * `encoding` y el `mimeType` real del archivo — no uno fijo: el reverso de este caso es PNG.
   */
  it('agrupa la rúbrica y la INE de Didit en signatureMedia con encoding y mimeType', () => {
    const xml = buildDocumentAuditXml(
      buildData({
        signers: [
          {
            id: 'col-2',
            email: 'simple@example.com',
            curp: 'CURP000000HDFABC02',
            signedAt: '2026-01-14T08:30:00.000Z',
            signatureType: 'SIMPLE',
            status: 'SIGNED',
            ipAddress: '10.0.0.2',
            geoLocation: null,
            advancedSignature: null,
            simpleSignature: {
              objectKey: 'rubrica.png',
              imageBase64: 'UE5H',
              identityDocumentFrontImage: {
                mimeType: 'image/jpeg',
                contentBase64: 'SU5FLUZSRU5URQ==',
              },
              identityDocumentBackImage: {
                mimeType: 'image/png',
                contentBase64: 'SU5FLVJFVkVSU08=',
              },
            },
          },
        ],
      }),
    );

    expect(xml).toContain(
      [
        '      <simpleSignature>',
        '        <signatureMedia>',
        '          <signatureImage encoding="base64" mimeType="image/png" objectKey="rubrica.png" available="true">UE5H</signatureImage>',
        '          <identityDocumentFrontImage encoding="base64" mimeType="image/jpeg" available="true">SU5FLUZSRU5URQ==</identityDocumentFrontImage>',
        '          <identityDocumentBackImage encoding="base64" mimeType="image/png" available="true">SU5FLVJFVkVSU08=</identityDocumentBackImage>',
        '        </signatureMedia>',
        '      </simpleSignature>',
      ].join('\n'),
    );
  });

  /**
   * Si Didit no entregó una cara, el nodo se declara no disponible y sin `mimeType`: un tipo MIME
   * para un contenido que no existe sería un atributo falso.
   */
  it('declara la cara de la INE que Didit no entregó, sin contenido ni mimeType', () => {
    const xml = buildDocumentAuditXml(
      buildData({
        signers: [
          {
            id: 'col-2',
            email: 'simple@example.com',
            curp: 'CURP000000HDFABC02',
            signedAt: '2026-01-14T08:30:00.000Z',
            signatureType: 'SIMPLE',
            status: 'SIGNED',
            ipAddress: '10.0.0.2',
            geoLocation: null,
            advancedSignature: null,
            simpleSignature: {
              objectKey: 'rubrica.png',
              imageBase64: 'UE5H',
              identityDocumentFrontImage: {
                mimeType: 'image/jpeg',
                contentBase64: 'SU5FLUZSRU5URQ==',
              },
              identityDocumentBackImage: {
                mimeType: null,
                contentBase64: null,
                unavailableReason: 'Sin reverso.',
              },
            },
          },
        ],
      }),
    );

    expect(xml).toContain(
      '<identityDocumentBackImage encoding="base64" available="false" unavailableReason="Sin reverso." />',
    );
    expect(nodeText(xml, 'identityDocumentFrontImage')).toBe(
      'SU5FLUZSRU5URQ==',
    );
  });

  it('marca la geolocalización ausente sin romper el nodo del firmante', () => {
    const xml = buildDocumentAuditXml(
      buildData({
        signers: [
          {
            id: 'col-3',
            email: null,
            curp: null,
            signedAt: null,
            signatureType: null,
            status: 'SIGNED',
            ipAddress: null,
            geoLocation: null,
            advancedSignature: null,
            simpleSignature: {
              objectKey: null,
              imageBase64: null,
              unavailableReason: 'El firmante no tiene una rúbrica registrada.',
              identityDocumentFrontImage: {
                mimeType: null,
                contentBase64: null,
                unavailableReason: 'Sin anverso.',
              },
              identityDocumentBackImage: {
                mimeType: null,
                contentBase64: null,
                unavailableReason: 'Sin reverso.',
              },
            },
          },
        ],
      }),
    );

    expect(xml).toContain('<geoLocation available="false" />');
    expect(xml).toContain('<email />');
    expect(xml).toContain(
      '<signatureImage encoding="base64" mimeType="image/png" available="false" unavailableReason="El firmante no tiene una rúbrica registrada." />',
    );
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import {
  Content,
  ContentTable,
  TDocumentDefinitions,
} from 'pdfmake/interfaces';
import { SummaryDocumentService } from './summary-document.service';
import {
  SummaryDocumentInfo,
  SummaryDocumentSigner,
} from './interfaces/summary-document.interface';

describe('SummaryDocumentService', () => {
  let service: SummaryDocumentService;

  const document: SummaryDocumentInfo = {
    id: '283dfad3-211e-48aa-9879-75ccf46b60ce',
    documentName: 'Cotizacion-FIEAC-Dig-2025',
    hash: 'bcca56f3e3ce15de8965d985312efef9598440d89cf6e90da35d5b0702c2deeb',
    totalPages: 1,
    createdBy: 'juan.cepeda@data-lo.com',
    verificationUrl: 'https://app.firmalo.mx/public/documents/283dfad3',
  };

  const signers: SummaryDocumentSigner[] = [
    {
      name: 'JUAN ANGEL CEPEDA FERNANDEZ',
      ipAddress: '189.237.82.225',
      otpCode: '482913',
      signedAt: new Date('2026-01-15T10:30:00Z'),
    },
    {
      name: 'MARIA GUADALUPE PEREZ LOPEZ',
      ipAddress: '201.100.10.5',
      otpCode: '109233',
      signedAt: new Date('2026-01-15T11:05:00Z'),
    },
  ];

  /** Todas las tablas de la hoja, ya aplanadas a pares [etiqueta, valor]. */
  function tablesOf(definition: TDocumentDefinitions): string[][][] {
    return (definition.content as Content[])
      .filter((item): item is ContentTable => 'table' in (item as ContentTable))
      .map((item) =>
        item.table.body.map((row) =>
          (row as { text: string }[]).map((cell) => cell.text),
        ),
      );
  }

  function buildDefinition(signersForSheet = signers): TDocumentDefinitions {
    return service['buildDocDefinition'](document, signersForSheet);
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SummaryDocumentService],
    }).compile();

    service = module.get(SummaryDocumentService);
  });

  it('genera un PDF válido a partir del documento y los firmantes', async () => {
    const buffer = await service.generateSummaryPdf(document, signers);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('genera un PDF sin firmantes sin lanzar errores', async () => {
    const buffer = await service.generateSummaryPdf(document, []);

    expect(buffer.length).toBeGreaterThan(0);
  });

  describe('encabezado y pie (plantilla de referencia)', () => {
    it('rotula la hoja como firma digital simple y lleva el logo', () => {
      const header = JSON.stringify(
        (buildDefinition().header as () => Content)(),
      );

      expect(header).toContain('Firma_Digital_Simple');
      expect(header).toContain('firmalo-logo.png');
    });

    it('el pie lleva el QR a la vista pública del documento y las leyendas legales', () => {
      const footer = JSON.stringify(
        (buildDefinition().footer as () => Content)(),
      );

      expect(footer).toContain(document.verificationUrl);
      expect(footer).toContain('no ha sido modificada');
      expect(footer).toContain('representación visual de un XML');
      // El pie lleva el isotipo (la marca sola); el lockup completo es del encabezado.
      expect(footer).toContain('firmalo-isotipo.png');
      expect(footer).not.toContain('firmalo-logo.png');
    });

    // El QR es el destino de verificación: sin `verificationUrl` se codifica el id del documento,
    // nunca queda vacío.
    it('sin URL de verificación, el QR codifica el id del documento', () => {
      const definition = service['buildDocDefinition'](
        { ...document, verificationUrl: undefined },
        signers,
      );

      expect(JSON.stringify((definition.footer as () => Content)())).toContain(
        document.id,
      );
    });
  });

  describe('tablas informativas', () => {
    it('imprime la información del documento con los campos de la plantilla', () => {
      const [documentInfo] = tablesOf(buildDefinition());

      expect(documentInfo).toEqual([
        ['ID', document.id],
        ['Nombre del documento', document.documentName],
        ['Hash', document.hash],
        ['No de paginas', '1'],
        ['Creado por', document.createdBy],
      ]);
    });

    // La constancia se emite DESPUÉS de armar la hoja (ver `sealAdvancedSignatures`), así que la
    // tabla existe pero todavía no tiene qué mostrar.
    it('deja vacía la tabla de la Constancia de Conservación (NOM-151)', () => {
      const [, nom151] = tablesOf(buildDefinition());

      expect(nom151).toEqual([
        ['Certificado (TSA)', ''],
        ['NUMERO DE SERIE', ''],
        ['EMITIDO', ''],
      ]);
    });

    it('genera una tabla de evidencia por cada firmante', () => {
      const [, , ...signerTables] = tablesOf(buildDefinition());

      expect(signerTables).toHaveLength(2);
      expect(signerTables[0].map(([label]) => label)).toEqual([
        'Nombre',
        'Tipo de Firma',
        'IP',
        'Sustentada',
        'OTP CODE',
        'Fecha de Firma',
      ]);
    });

    /**
     * Historia "Ocultar geolocalización en hojas de firma y vistas públicas": la hoja se anexa
     * al PDF firmado y se conserva por años, así que la ausencia del renglón se afirma en vez
     * de darse por hecha. El dato sigue guardado en `CollaboratorEntity.geoLoc`.
     */
    it('no imprime ningún renglón de geolocalización', () => {
      const [, , ...signerTables] = tablesOf(buildDefinition());

      for (const table of signerTables) {
        expect(table.map(([label]) => label)).not.toContain('Geo Loc');
        expect(table.flat().join(' ')).not.toMatch(/geo/i);
      }
    });

    it('toma los datos de cada firmante', () => {
      const [, , firstSigner] = tablesOf(buildDefinition());
      const valueOf = (label: string) =>
        firstSigner.find((row) => row[0] === label)?.[1];

      expect(valueOf('Nombre')).toBe('JUAN ANGEL CEPEDA FERNANDEZ');
      expect(valueOf('Tipo de Firma')).toBe('Digital Simple');
      expect(valueOf('IP')).toBe('189.237.82.225');
      expect(valueOf('OTP CODE')).toBe('482913');
      expect(valueOf('Sustentada')).toContain('Arts. 89, 90 y 93');
    });

    it('deja en blanco los datos que el firmante no registró, sin romper la tabla', () => {
      const [, , onlySigner] = tablesOf(
        buildDefinition([
          {
            name: 'SIN DATOS',
            ipAddress: '10.0.0.1',
            otpCode: null,
            signedAt: null,
          },
        ]),
      );
      const valueOf = (label: string) =>
        onlySigner.find((row) => row[0] === label)?.[1];

      expect(valueOf('OTP CODE')).toBe('');
      expect(valueOf('Fecha de Firma')).toBe('');
    });
  });

  describe('tipografías de la plantilla', () => {
    it('usa JetBrains Mono en tablas y separadores, y Lato en el texto corrido', () => {
      const definition = buildDefinition();

      expect(definition.defaultStyle).toEqual(
        expect.objectContaining({ font: 'Lato' }),
      );
      expect(definition.styles).toEqual(
        expect.objectContaining({
          mono: expect.objectContaining({ font: 'JetBrainsMono' }),
          legal: expect.objectContaining({ font: 'Lato' }),
        }),
      );

      // Los separadores de guiones son monoespaciados: dependen del ancho fijo por carácter.
      const banner = (definition.content as Content[]).find(
        (item) =>
          typeof (item as { text?: string }).text === 'string' &&
          (item as { text: string }).text.includes('Firmalo_Grafo'),
      );
      expect(banner).toEqual(expect.objectContaining({ style: 'mono' }));
    });
  });
});

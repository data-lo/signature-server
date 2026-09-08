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
        ['Nombre del Documento', document.documentName],
        ['Hash', document.hash],
        ['No. de Páginas', '1'],
        ['Creado por', document.createdBy],
      ]);
    });

    /**
     * La firma simple TAMBIÉN se sella ante el PSC. Esta tabla salía siempre vacía porque el
     * sellado corría después de armar la hoja y la constancia ni siquiera se persistía.
     */
    it('imprime la Constancia de Conservación (NOM-151) del sello', () => {
      const [, nom151] = tablesOf(
        service['buildDocDefinition'](
          {
            ...document,
            conservationRecord: {
              tsaCertificate: 'Autoridad CCMD de PSC CODEX TUL',
              serialNumber: '00E4',
              issuedAt: new Date('2026-08-20T15:05:00.000Z'),
            },
          },
          signers,
        ),
      );

      expect(nom151.map(([label]) => label)).toEqual([
        'Certificado (TSA)',
        'Número de Serie',
        'Emitido',
      ]);
      expect(nom151[0][1]).toBe('Autoridad CCMD de PSC CODEX TUL');
      expect(nom151[1][1]).toBe('00E4');
      expect(nom151[2][1]).not.toBe('');
    });

    // El sellado es best-effort: si falla, la hoja se arma igual. La tabla es parte de la
    // plantilla de referencia, así que se imprime vacía en vez de desaparecer.
    it('deja vacía la tabla NOM-151 cuando el documento no llegó a sellarse', () => {
      const [, nom151] = tablesOf(buildDefinition());

      expect(nom151).toEqual([
        ['Certificado (TSA)', ''],
        ['Número de Serie', ''],
        ['Emitido', ''],
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
        'OTP Code',
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
      expect(valueOf('OTP Code')).toBe('482913');
      expect(valueOf('Sustentada')).toContain('Arts. 89, 90 y 93');
    });

    /**
     * La fecha de firma se imprime como marca Unix en milisegundos: sólo dígitos, sin zona
     * horaria ni convención de fecha que interpretar. Se afirma el número exacto porque es el
     * mismo valor que la vista previa muestra a partir del mismo `signedAt`.
     */
    it('imprime la fecha de firma como timestamp Unix en milisegundos', () => {
      const [, , firstSigner] = tablesOf(buildDefinition());
      const fechaDeFirma = firstSigner.find(
        ([label]) => label === 'Fecha de Firma',
      )?.[1];

      expect(fechaDeFirma).toBe(
        String(new Date('2026-01-15T10:30:00Z').getTime()),
      );
      expect(fechaDeFirma).toMatch(/^\d+$/);
    });

    /**
     * Lo que esta prueba impide es una regresión al formato anterior: una fecha localizada
     * (`15/01/26 4:30:00`) o ISO (`2026-01-15T10:30:00.000Z`) se rendía en la zona horaria de
     * quien generó el PDF, así que el mismo instante podía imprimirse distinto según dónde
     * corriera el proceso.
     */
    it('no imprime ninguna fecha legible ni ISO en la tabla del firmante', () => {
      const [, , firstSigner] = tablesOf(buildDefinition());

      for (const [, value] of firstSigner) {
        expect(value).not.toMatch(/\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/);
        expect(value).not.toMatch(/T\d{2}:\d{2}/);
      }
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

      expect(valueOf('OTP Code')).toBe('');
      expect(valueOf('Fecha de Firma')).toBe('');
    });
  });

  /**
   * Historia "Capitalizar títulos hojas de evidencia": los rótulos de la hoja van en
   * capitalización tipo título y no en mayúsculas sostenidas, que es como se leían antes
   * (`NUMERO DE SERIE`). La hoja se anexa al PDF firmado y se conserva por años, así que la regla
   * se afirma sobre TODOS los rótulos y no sobre los que hoy nos acordamos de revisar.
   *
   * Sólo aplica a los rótulos y a los títulos de sección. Los VALORES quedan fuera a propósito:
   * el nombre de un firmante llega en mayúsculas desde su identificación oficial y reescribirlo
   * sería alterar evidencia.
   */
  describe('capitalización de los rótulos', () => {
    /**
     * Siglas y códigos que SÍ van en mayúsculas: no son títulos mal escritos. Se comparan por
     * palabra suelta porque conviven con texto normal dentro de un mismo rótulo
     * (`Certificado (TSA)`, `Constancia de Conservación (NOM-151)`).
     */
    const TECHNICAL_TOKENS = [
      'ID',
      'IP',
      'TSA',
      'NOM',
      'OTP',
      'RFC',
      'CURP',
      'UUID',
      'SHA',
      'PSC',
      'XML',
      'QR',
    ];

    /** ¿Este texto lleva alguna palabra gritada en mayúsculas que no sea una sigla conocida? */
    function shoutedWordsIn(text: string): string[] {
      return text
        .split(/[\s().,:/-]+/)
        .filter(Boolean)
        .filter((word) => /[A-ZÁÉÍÓÚÑ]/.test(word))
        .filter((word) => word === word.toUpperCase())
        .filter((word) => !TECHNICAL_TOKENS.includes(word))
        .filter((word) => !/^\d+$/.test(word));
    }

    /** Los títulos de sección de la hoja (`Información del Documento.` y hermanos). */
    function sectionTitlesOf(definition: TDocumentDefinitions): string[] {
      return (definition.content as Content[])
        .filter(
          (item): item is { text: string; style: string } =>
            typeof (item as { text?: unknown }).text === 'string' &&
            (item as { style?: unknown }).style === 'sectionTitle',
        )
        .map((item) => item.text);
    }

    it('ningún rótulo de las tablas está en mayúsculas sostenidas', () => {
      const labels = tablesOf(buildDefinition()).flatMap((table) =>
        table.map(([label]) => label),
      );

      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        expect(shoutedWordsIn(label)).toEqual([]);
      }
    });

    it('ningún título de sección está en mayúsculas sostenidas', () => {
      const titles = sectionTitlesOf(buildDefinition());

      expect(titles.length).toBeGreaterThan(0);
      for (const title of titles) {
        expect(shoutedWordsIn(title)).toEqual([]);
      }
    });

    /** Cada palabra con significado propio abre en mayúscula; las preposiciones no. */
    it('los rótulos abren cada palabra en mayúscula, salvo preposiciones y artículos', () => {
      const labels = tablesOf(buildDefinition()).flatMap((table) =>
        table.map(([label]) => label),
      );
      const lowercaseWords = ['de', 'del', 'por', 'la', 'el', 'y'];

      for (const label of labels) {
        const words = label.split(/[\s()]+/).filter(Boolean);
        for (const word of words) {
          if (lowercaseWords.includes(word)) continue;
          expect(word[0]).toBe(word[0].toUpperCase());
        }
      }
    });

    /** El ejemplo del reporte, afirmado tal cual. */
    it('imprime "Número de Serie" y no "NUMERO DE SERIE"', () => {
      const labels = tablesOf(buildDefinition()).flatMap((table) =>
        table.map(([label]) => label),
      );

      expect(labels).toContain('Número de Serie');
      expect(labels).not.toContain('NUMERO DE SERIE');
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

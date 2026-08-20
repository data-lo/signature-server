import { Test, TestingModule } from '@nestjs/testing';
import {
  Content,
  ContentTable,
  TDocumentDefinitions,
} from 'pdfmake/interfaces';
import { AdvancedSummaryDocumentService } from './advanced-summary-document.service';
import {
  AdvancedSummaryDocumentInfo,
  AdvancedSummaryDocumentSigner,
} from './interfaces/advanced-summary-document.interface';

describe('AdvancedSummaryDocumentService', () => {
  let service: AdvancedSummaryDocumentService;

  const document: AdvancedSummaryDocumentInfo = {
    id: '283dfad3-211e-48aa-9879-75ccf46b60ce',
    documentName: 'Cotizacion-FIEAC-Dig-2025',
    hash: 'bcca56f3e3ce15de8965d985312efef9598440d89cf6e90da35d5b0702c2deeb',
    totalPages: 1,
    createdBy: 'juan.cepeda@data-lo.com',
  };

  const signers: AdvancedSummaryDocumentSigner[] = [
    {
      name: 'JUAN ANGEL CEPEDA FERNANDEZ',
      ipAddress: '189.237.82.225',
      certificateSerialNumber: '30001000000500003416',
      electronicSignature: 'a'.repeat(344),
      signedAt: new Date('2026-01-15T10:30:00Z'),
      geoLocation: null,
    },
    {
      name: 'MARIA GUADALUPE PEREZ LOPEZ',
      ipAddress: '201.100.10.5',
      certificateSerialNumber: '30001000000500009999',
      electronicSignature: 'b'.repeat(344),
      signedAt: new Date('2026-01-15T11:05:00Z'),
      geoLocation: '19.4326,-99.1332',
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
      providers: [AdvancedSummaryDocumentService],
    }).compile();

    service = module.get(AdvancedSummaryDocumentService);
  });

  it('genera un PDF válido a partir del documento y los firmantes', async () => {
    const buffer = await service.generateAdvancedSummaryPdf(document, signers);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('genera un PDF sin firmantes sin lanzar errores', async () => {
    const buffer = await service.generateAdvancedSummaryPdf(document, []);

    expect(buffer.length).toBeGreaterThan(0);
  });

  it('identifica la hoja como evidencia de firma avanzada', () => {
    const definition = buildDefinition();
    const header = (definition.header as () => Content)();

    expect(JSON.stringify(header)).toContain('Firma_Electrónica_Avanzada');
    expect(JSON.stringify(definition.content)).toContain('Firmalo_FIEL');
  });

  it('imprime la información del documento sin el campo "Cifrado" de la hoja simple', () => {
    const [documentInfo] = tablesOf(buildDefinition());

    expect(documentInfo).toEqual([
      ['ID', document.id],
      ['Nombre del documento', document.documentName],
      ['Hash', document.hash],
      ['No de paginas', '1'],
      ['Creado por', document.createdBy],
    ]);
  });

  // Pedido explícito de la historia: la tabla existe en la hoja, pero todavía sin datos.
  it('deja vacía la tabla de la Constancia de Conservación (NOM-151)', () => {
    const [, nom151] = tablesOf(buildDefinition());

    expect(nom151).toEqual([
      ['Certificado (TSA)', ''],
      ['NUMERO DE SERIE', ''],
      ['EMITIDO', ''],
    ]);
  });

  it('genera una tabla de evidencia por cada firmante del documento', () => {
    const [, , ...signerTables] = tablesOf(buildDefinition());

    expect(signerTables).toHaveLength(2);
    expect(signerTables[0][0]).toEqual([
      'Nombre',
      'JUAN ANGEL CEPEDA FERNANDEZ',
    ]);
    expect(signerTables[1][0]).toEqual([
      'Nombre',
      'MARIA GUADALUPE PEREZ LOPEZ',
    ]);
  });

  it('toma el número de serie del certificado y la firma electrónica del firmante', () => {
    const [, , firstSigner] = tablesOf(buildDefinition());
    const valueOf = (label: string) =>
      firstSigner.find((row) => row[0] === label)?.[1];

    expect(valueOf('Número de Serie del Certificado')).toBe(
      '30001000000500003416',
    );
    expect(valueOf('Tipo de Firma')).toBe('Firma Electronica Avanzada');
    expect(valueOf('IP')).toBe('189.237.82.225');
    expect(valueOf('Geo Loc')).toBe('');
    // La firma llega completa; solo se le agregan cortes de renglón para que quepa en la celda.
    expect(valueOf('Firma Electrónica')?.replace(/\n/g, '')).toBe(
      'a'.repeat(344),
    );
    expect(valueOf('Firma Electrónica')).toContain('\n');
  });

  // Una firma avanzada sin evidencia guardada (fila anterior a que se persistiera
  // `advancedSignature`) no debe romper la generación del documento final.
  it('deja los campos del certificado en blanco si el firmante no trae evidencia', () => {
    const [, , onlySigner] = tablesOf(
      buildDefinition([
        {
          name: 'SIN EVIDENCIA',
          ipAddress: '10.0.0.1',
          certificateSerialNumber: null,
          electronicSignature: null,
          signedAt: null,
          geoLocation: null,
        },
      ]),
    );
    const valueOf = (label: string) =>
      onlySigner.find((row) => row[0] === label)?.[1];

    expect(valueOf('Número de Serie del Certificado')).toBe('');
    expect(valueOf('Firma Electrónica')).toBe('');
    expect(valueOf('Fecha de Firma')).toBe('');
  });
});

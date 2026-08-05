import { Test, TestingModule } from '@nestjs/testing';
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
    cipher: 'axQt1g9gnWM48EAptMHZ2THiezR71EJlxCT9f1V7d2/HKFR6ayViaeNbakCQKps=',
    totalPages: 1,
    createdBy: 'juan.cepeda@data-lo.com',
  };

  const signers: SummaryDocumentSigner[] = [
    {
      name: 'JUAN ANGEL CEPEDA FERNANDEZ',
      rfc: null,
      ipAddress: '189.237.82.225',
      otpCode: null,
      signedAt: new Date('2026-01-15T10:30:00Z'),
      geoLocation: null,
    },
    {
      name: 'MARIA GUADALUPE PEREZ LOPEZ',
      rfc: 'PELM850101ABC',
      ipAddress: '201.100.10.5',
      otpCode: '482913',
      signedAt: new Date('2026-01-15T11:05:00Z'),
      geoLocation: '19.4326,-99.1332',
    },
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SummaryDocumentService],
    }).compile();

    service = module.get(SummaryDocumentService);
  });

  it('genera un PDF válido a partir del documento y los firmantes', async () => {
    const buffer = await service.generateSummaryPdf(document, signers);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('genera un PDF sin firmantes sin lanzar errores', async () => {
    const buffer = await service.generateSummaryPdf(document, []);

    expect(buffer.length).toBeGreaterThan(0);
  });
});

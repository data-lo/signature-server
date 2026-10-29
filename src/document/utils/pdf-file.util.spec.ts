import { BadRequestException } from '@nestjs/common';

import { assertPdfFile } from './pdf-file.util';

describe('assertPdfFile', () => {
  it('acepta un PDF por tipo y por contenido', () => {
    expect(() =>
      assertPdfFile({
        mimetype: 'application/pdf',
        buffer: Buffer.from('%PDF-1.7\n…'),
      }),
    ).not.toThrow();
  });

  it('tolera bytes antes de la cabecera, como los lectores de PDF', () => {
    expect(() =>
      assertPdfFile({
        mimetype: 'application/pdf',
        buffer: Buffer.concat([
          Buffer.alloc(100, 0x20),
          Buffer.from('%PDF-1.4'),
        ]),
      }),
    ).not.toThrow();
  });

  it('rechaza otro tipo declarado aunque el contenido sea PDF', () => {
    expect(() =>
      assertPdfFile({ mimetype: 'image/png', buffer: Buffer.from('%PDF-1.7') }),
    ).toThrow(BadRequestException);
  });

  it.each([
    ['un PNG renombrado', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])],
    ['un texto cualquiera', Buffer.from('hola, no soy un pdf')],
    ['un archivo vacío', Buffer.alloc(0)],
    [
      'la cabecera después de 1024 bytes',
      Buffer.concat([Buffer.alloc(1100), Buffer.from('%PDF-1.4')]),
    ],
  ])('rechaza %s declarado como application/pdf', (_label, buffer) => {
    expect(() =>
      assertPdfFile({ mimetype: 'application/pdf', buffer }),
    ).toThrow(BadRequestException);
  });
});

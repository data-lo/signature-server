import { BadRequestException } from '@nestjs/common';

import { SignaturePositionDto } from '../dto/create-document-signatures.dto';
import { assertSignaturePositionsInsideDocument } from './signature-position.util';

function position(
  overrides: Partial<SignaturePositionDto> = {},
): SignaturePositionDto {
  return {
    page: 1,
    xRatio: 0.1,
    yRatio: 0.1,
    widthRatio: 0.2,
    heightRatio: 0.08,
    ...overrides,
  };
}

describe('assertSignaturePositionsInsideDocument', () => {
  it('acepta posiciones dentro de páginas existentes', () => {
    expect(() =>
      assertSignaturePositionsInsideDocument(
        [position(), position({ page: 3, xRatio: 0.5 })],
        3,
      ),
    ).not.toThrow();
  });

  it('acepta una caja pegada al borde aunque la suma dé apenas más de 1 en coma flotante', () => {
    const widthRatio = 0.1 + 0.2; // 0.30000000000000004
    expect(() =>
      assertSignaturePositionsInsideDocument(
        [position({ xRatio: 1 - widthRatio + 1e-12, widthRatio })],
        1,
      ),
    ).not.toThrow();
  });

  it('rechaza una página mayor que las del documento', () => {
    expect(() =>
      assertSignaturePositionsInsideDocument([position({ page: 2 })], 1),
    ).toThrow(BadRequestException);
  });

  it.each([
    ['a lo ancho', { xRatio: 0.85, widthRatio: 0.2 }],
    ['a lo alto', { yRatio: 0.95, heightRatio: 0.08 }],
  ])('rechaza una caja que se sale de la página %s', (_name, box) => {
    expect(() =>
      assertSignaturePositionsInsideDocument([position(box)], 1),
    ).toThrow('se sale de los límites de la página');
  });
});

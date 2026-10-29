import { BadRequestException } from '@nestjs/common';

import { SignaturePositionDto } from '../dto/create-document-signatures.dto';
import {
  assertNoOverlappingSignaturePositions,
  findOverlappingSignaturePositions,
} from './signature-collision.util';

function box(
  overrides: Partial<SignaturePositionDto> = {},
): SignaturePositionDto {
  return {
    page: 1,
    xRatio: 0.1,
    yRatio: 0.1,
    widthRatio: 0.2,
    heightRatio: 0.1,
    ...overrides,
  };
}

describe('signature-collision.util', () => {
  it('encuentra el par que se traslapa, por referencia', () => {
    const a = box();
    const b = box({ xRatio: 0.2 });

    expect(findOverlappingSignaturePositions(new Map([[1, [a, b]]]))).toEqual([
      a,
      b,
    ]);
  });

  it('bordes que sólo se tocan no se traslapan', () => {
    expect(
      findOverlappingSignaturePositions(
        new Map([
          [1, [box({ xRatio: 0.25, widthRatio: 0.25 }), box({ xRatio: 0.5 })]],
        ]),
      ),
    ).toBeNull();
  });

  it('el assert de la plataforma conserva su 400 y su mensaje', () => {
    expect(() =>
      assertNoOverlappingSignaturePositions(
        new Map([[1, [box(), box({ yRatio: 0.15 })]]]),
      ),
    ).toThrow(
      new BadRequestException(
        'Las firmas de los colaboradores no pueden solaparse en la misma página',
      ),
    );
  });
});

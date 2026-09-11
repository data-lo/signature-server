import { detectImageContentType } from './image-content-type.util';

describe('detectImageContentType', () => {
  it('reconoce un JPEG por sus bytes mágicos', () => {
    expect(
      detectImageContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])),
    ).toBe('image/jpeg');
  });

  it('reconoce un PNG', () => {
    expect(
      detectImageContentType(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      ),
    ).toBe('image/png');
  });

  it('reconoce un WebP', () => {
    expect(
      detectImageContentType(
        Buffer.concat([
          Buffer.from('RIFF'),
          Buffer.from([0x10, 0x00, 0x00, 0x00]),
          Buffer.from('WEBP'),
        ]),
      ),
    ).toBe('image/webp');
  });

  it.each([
    ['un PDF', Buffer.from('%PDF-1.7')],
    ['texto', Buffer.from('<html></html>')],
    ['un archivo vacío', Buffer.alloc(0)],
    ['un JPEG truncado', Buffer.from([0xff, 0xd8])],
  ])('no reconoce %s como imagen', (_caso, content) => {
    expect(detectImageContentType(content)).toBeNull();
  });
});

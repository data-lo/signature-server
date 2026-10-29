import { extractIdentityDocumentImageUrls } from './didit-identity-images';

const FRONT = 'https://cdn.didit.me/ine-front.jpg';
const BACK = 'https://cdn.didit.me/ine-back.jpg';

describe('extractIdentityDocumentImageUrls', () => {
  it('lee las imágenes de la forma V3 (id_verifications es un arreglo)', () => {
    expect(
      extractIdentityDocumentImageUrls({
        id_verifications: [
          { status: 'Approved', front_image: FRONT, back_image: BACK },
        ],
      }),
    ).toEqual({ front: FRONT, back: BACK });
  });

  it('lee las imágenes de la forma V2 (id_verification es un objeto)', () => {
    expect(
      extractIdentityDocumentImageUrls({
        id_verification: { front_image: FRONT, back_image: BACK },
      }),
    ).toEqual({ front: FRONT, back: BACK });
  });

  it('prefiere la primera lectura de documento que traiga las dos imágenes', () => {
    expect(
      extractIdentityDocumentImageUrls({
        id_verifications: [
          { front_image: 'https://cdn.didit.me/solo-frente.jpg' },
          { front_image: FRONT, back_image: BACK },
        ],
      }),
    ).toEqual({ front: FRONT, back: BACK });
  });

  it('informa cuál falta cuando ninguna lectura trae las dos', () => {
    expect(
      extractIdentityDocumentImageUrls({
        id_verifications: [{ front_image: FRONT }],
      }),
    ).toEqual({ front: FRONT, back: null });
  });

  it.each([
    ['sin veredicto', null],
    ['sin bloque de documento', { face_match: { status: 'match' } }],
    [
      'con valores que no son texto',
      { id_verification: { front_image: 1, back_image: {} } },
    ],
    [
      'con cadenas vacías',
      { id_verification: { front_image: ' ', back_image: '' } },
    ],
  ])('no encuentra imágenes %s', (_caso, decision) => {
    expect(extractIdentityDocumentImageUrls(decision as never)).toEqual({
      front: null,
      back: null,
    });
  });

  /** Frontera de datos personales: del veredicto sólo salen las dos URLs. */
  it('no devuelve ningún otro dato del veredicto', () => {
    const result = extractIdentityDocumentImageUrls({
      id_verifications: [
        {
          first_name: 'Juan',
          document_number: 'PELJ850101HDFRNN08',
          front_image: FRONT,
          back_image: BACK,
        },
      ],
    });

    expect(Object.keys(result)).toEqual(['front', 'back']);
    expect(JSON.stringify(result)).not.toContain('Juan');
  });
});

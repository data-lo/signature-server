import { ConfigService } from '@nestjs/config';

import {
  INTEGRATION_VALIDATION_CODE_ENUM as CODE,
  IntegrationValidationException,
} from './integration-validation.exception';
import { IntegrationPayloadValidator } from './integration-payload.validator';

type Plain = Record<string, any>;

const position = (overrides: Plain = {}) => ({
  page: 1,
  xRatio: 0.1,
  yRatio: 0.1,
  widthRatio: 0.2,
  heightRatio: 0.06,
  ...overrides,
});

const signer = (email: string, order: number, overrides: Plain = {}) => ({
  role: 'SIGNER',
  firstName: 'Luis',
  lastName: 'Martínez',
  email,
  order,
  signaturePositions: [position({ yRatio: 0.1 * order })],
  ...overrides,
});

const witness = (email: string, overrides: Plain = {}) => ({
  role: 'WITNESS',
  firstName: 'Eva',
  lastName: 'Ruiz',
  email,
  ...overrides,
});

function payload(patch: (value: Plain) => void = () => {}): string {
  const value: Plain = {
    creator: { email: 'ana@cliente.com', firstName: 'Ana', lastName: 'López' },
    document: { signatureType: 'SIMPLE', isSequential: true },
    participants: [signer('luis@correo.com', 1), witness('eva@correo.com')],
  };
  patch(value);
  return JSON.stringify(value);
}

function validator(config: Record<string, unknown> = {}) {
  return new IntegrationPayloadValidator({
    get: (key: string) => config[key],
  } as unknown as ConfigService);
}

/** Ejecuta y devuelve el cuerpo del error de integración, o falla si no lanzó. */
function errorOf(run: () => unknown): Plain {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(IntegrationValidationException);
    return (error as IntegrationValidationException).getResponse() as Plain;
  }
  throw new Error('se esperaba un IntegrationValidationException');
}

describe('IntegrationPayloadValidator', () => {
  it('acepta un payload válido y normaliza los correos', () => {
    const result = validator().validatePayload(
      payload((value) => {
        value.participants[0].email = '  Luis@Correo.COM ';
      }),
    );

    expect(result.participants[0].email).toBe('luis@correo.com');
  });

  it('todo error es 422 con código, mensaje y detalles', () => {
    const error = new IntegrationValidationException(
      CODE.SIGNER_REQUIRED,
      'mensaje',
      { field: 'participants' },
    );

    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toEqual({
      statusCode: 422,
      code: CODE.SIGNER_REQUIRED,
      message: 'mensaje',
      details: { field: 'participants' },
    });
  });

  describe('payload', () => {
    it.each([
      ['ausente', undefined],
      ['que no es JSON', '{no es json'],
      ['que es un arreglo', '[]'],
    ])('rechaza un payload %s con INVALID_PAYLOAD', (_label, raw) => {
      expect(errorOf(() => validator().validatePayload(raw))).toMatchObject({
        code: CODE.INVALID_PAYLOAD,
        details: { field: 'payload' },
      });
    });

    it('rechaza un creador inválido con INVALID_CREATOR y su campo', () => {
      expect(
        errorOf(() =>
          validator().validatePayload(
            payload((value) => (value.creator.email = 'no-es-correo')),
          ),
        ),
      ).toMatchObject({
        code: CODE.INVALID_CREATOR,
        details: { field: 'creator.email', reason: 'isEmail' },
      });
    });

    it('rechaza opciones de documento inválidas con INVALID_DOCUMENT_OPTIONS', () => {
      expect(
        errorOf(() =>
          validator().validatePayload(
            payload((value) => (value.document.signatureType = 'OTRA')),
          ),
        ),
      ).toMatchObject({
        code: CODE.INVALID_DOCUMENT_OPTIONS,
        details: { field: 'document.signatureType' },
      });
    });
  });

  describe('lista de colaboradores', () => {
    it.each([
      ['ausente', (value: Plain) => delete value.participants],
      ['que no es un arreglo', (value: Plain) => (value.participants = {})],
      ['vacía', (value: Plain) => (value.participants = [])],
    ])('rechaza una lista %s con PARTICIPANTS_REQUIRED', (_label, patch) => {
      expect(
        errorOf(() => validator().validatePayload(payload(patch))),
      ).toMatchObject({
        code: CODE.PARTICIPANTS_REQUIRED,
        details: { field: 'participants' },
      });
    });

    it('rechaza un documento sin SIGNER', () => {
      expect(
        errorOf(() =>
          validator().validatePayload(
            payload(
              (value) => (value.participants = [witness('eva@correo.com')]),
            ),
          ),
        ),
      ).toMatchObject({ code: CODE.SIGNER_REQUIRED });
    });

    it('rechaza más colaboradores que el máximo (50 por omisión)', () => {
      const participants = Array.from({ length: 53 }, (_, index) =>
        witness(`t${index}@correo.com`),
      );

      expect(
        errorOf(() =>
          validator().validatePayload(
            payload((value) => (value.participants = participants)),
          ),
        ),
      ).toEqual({
        statusCode: 422,
        code: CODE.MAX_PARTICIPANTS_EXCEEDED,
        message: 'El documento admite como máximo 50 colaboradores.',
        details: { field: 'participants', limit: 50, received: 53 },
      });
    });

    it('respeta MAX_INTEGRATION_DOCUMENT_PARTICIPANTS', () => {
      expect(
        errorOf(() =>
          validator({
            MAX_INTEGRATION_DOCUMENT_PARTICIPANTS: '1',
          }).validatePayload(payload()),
        ),
      ).toMatchObject({
        code: CODE.MAX_PARTICIPANTS_EXCEEDED,
        details: { limit: 1, received: 2 },
      });
    });

    it('rechaza correos repetidos aunque cambien de rol, mayúsculas o espacios', () => {
      expect(
        errorOf(() =>
          validator().validatePayload(
            payload((value) => {
              value.participants = [
                signer('ana@correo.com', 1),
                witness('eva@correo.com'),
                witness('  ANA@correo.com'),
              ];
            }),
          ),
        ),
      ).toEqual({
        statusCode: 422,
        code: CODE.DUPLICATE_PARTICIPANT_EMAIL,
        message:
          'Un colaborador sólo puede participar una vez en el documento.',
        details: {
          field: 'participants[2].email',
          email: 'ana@correo.com',
          duplicateOf: 'participants[0].email',
        },
      });
    });
  });

  describe('datos de cada colaborador', () => {
    it.each([
      [
        'un rol fuera del catálogo',
        { role: 'VIEWER' },
        CODE.INVALID_PARTICIPANT_ROLE,
        'participants[0].role',
      ],
      [
        'sin nombre',
        { firstName: '   ' },
        CODE.INVALID_PARTICIPANT_NAME,
        'participants[0].firstName',
      ],
      [
        'un apellido demasiado largo',
        { lastName: 'x'.repeat(101) },
        CODE.INVALID_PARTICIPANT_NAME,
        'participants[0].lastName',
      ],
      [
        'sin correo',
        { email: undefined },
        CODE.INVALID_PARTICIPANT_EMAIL,
        'participants[0].email',
      ],
      [
        'un correo inválido',
        { email: 'luis@' },
        CODE.INVALID_PARTICIPANT_EMAIL,
        'participants[0].email',
      ],
      [
        'un orden no entero',
        { order: 1.5 },
        CODE.INVALID_SIGNING_ORDER,
        'participants[0].order',
      ],
      [
        'un orden menor que 1',
        { order: 0 },
        CODE.INVALID_SIGNING_ORDER,
        'participants[0].order',
      ],
    ])('rechaza %s', (_label, overrides, code, field) => {
      expect(
        errorOf(() =>
          validator().validatePayload(
            payload((value) => Object.assign(value.participants[0], overrides)),
          ),
        ),
      ).toMatchObject({ code, details: { field } });
    });

    it('un rol inválido lista los permitidos', () => {
      expect(
        errorOf(() =>
          validator().validatePayload(
            payload((value) => (value.participants[0].role = 'VIEWER')),
          ),
        ).details,
      ).toMatchObject({ allowed: ['SIGNER', 'WITNESS'] });
    });

    it.each([
      ['sin posiciones', undefined],
      ['con un arreglo vacío', []],
    ])('rechaza un firmante %s', (_label, signaturePositions) => {
      expect(
        errorOf(() =>
          validator().validatePayload(
            payload(
              (value) =>
                (value.participants[0].signaturePositions = signaturePositions),
            ),
          ),
        ),
      ).toMatchObject({
        code: CODE.SIGNER_SIGNATURE_POSITION_REQUIRED,
        details: { field: 'participants[0].signaturePositions' },
      });
    });

    it('rechaza un testigo con posiciones de firma', () => {
      expect(
        errorOf(() =>
          validator().validatePayload(
            payload(
              (value) =>
                (value.participants[1].signaturePositions = [position()]),
            ),
          ),
        ),
      ).toMatchObject({
        code: CODE.WITNESS_SIGNATURE_POSITION_NOT_ALLOWED,
        details: { field: 'participants[1].signaturePositions' },
      });
    });

    it('respeta MAX_INTEGRATION_SIGNATURE_POSITIONS_PER_SIGNER si está configurado', () => {
      const raw = payload((value) => {
        value.participants[0].signaturePositions = [
          position({ page: 1 }),
          position({ page: 2 }),
        ];
      });

      expect(() => validator().validatePayload(raw)).not.toThrow();
      expect(
        errorOf(() =>
          validator({
            MAX_INTEGRATION_SIGNATURE_POSITIONS_PER_SIGNER: '1',
          }).validatePayload(raw),
        ),
      ).toMatchObject({
        code: CODE.MAX_SIGNATURE_POSITIONS_EXCEEDED,
        details: { limit: 1, received: 2 },
      });
    });
  });

  describe('RFC del firmante avanzado', () => {
    it('acepta el RFC de un firmante ADVANCED, normalizado a mayúsculas', () => {
      const result = validator().validatePayload(
        payload((value) => {
          value.document.signatureType = 'ADVANCED';
          value.participants[0].rfc = ' lopa800101ab1 ';
        }),
      );
      expect(result.participants[0].rfc).toBe('LOPA800101AB1');
    });

    it('rechaza un RFC con formato inválido', () => {
      expect(
        errorOf(() =>
          validator().validatePayload(
            payload((value) => {
              value.document.signatureType = 'ADVANCED';
              value.participants[0].rfc = 'NO-ES-RFC';
            }),
          ),
        ),
      ).toMatchObject({ code: CODE.INVALID_PARTICIPANT_RFC });
    });

    it('rechaza el RFC en un documento que no es ADVANCED', () => {
      expect(
        errorOf(() =>
          validator().validatePayload(
            payload((value) => (value.participants[0].rfc = 'LOPA800101AB1')),
          ),
        ),
      ).toMatchObject({
        code: CODE.PARTICIPANT_RFC_NOT_ALLOWED,
        details: { field: 'participants[0].rfc' },
      });
    });

    it('rechaza el RFC en un testigo', () => {
      expect(
        errorOf(() =>
          validator().validatePayload(
            payload((value) => {
              value.document.signatureType = 'ADVANCED';
              value.participants[1].rfc = 'LOPA800101AB1';
            }),
          ),
        ),
      ).toMatchObject({
        code: CODE.PARTICIPANT_RFC_NOT_ALLOWED,
        details: { field: 'participants[1].rfc' },
      });
    });
  });

  describe('orden de firma', () => {
    const signers =
      (...orders: (number | undefined)[]) =>
      (value: Plain) => {
        value.participants = orders.map((order, index) =>
          // Una fila por firmante para que no se traslapen, aunque `order` falte.
          signer(`s${index}@correo.com`, order as number, {
            signaturePositions: [position({ yRatio: 0.1 * (index + 1) })],
          }),
        );
      };

    it('acepta un orden único y consecutivo en cualquier posición del arreglo', () => {
      expect(() =>
        validator().validatePayload(payload(signers(2, 1, 3))),
      ).not.toThrow();
    });

    it('exige order en cada firmante de un documento secuencial', () => {
      expect(
        errorOf(() =>
          validator().validatePayload(payload(signers(1, undefined))),
        ),
      ).toMatchObject({
        code: CODE.INVALID_SIGNING_ORDER,
        details: { field: 'participants[1].order', reason: 'REQUIRED' },
      });
    });

    it('rechaza órdenes repetidos', () => {
      expect(
        errorOf(() => validator().validatePayload(payload(signers(1, 2, 2)))),
      ).toMatchObject({
        code: CODE.DUPLICATE_SIGNING_ORDER,
        details: {
          field: 'participants[2].order',
          order: 2,
          duplicateOf: 'participants[1].order',
        },
      });
    });

    it('rechaza órdenes que no son consecutivos desde 1', () => {
      expect(
        errorOf(() => validator().validatePayload(payload(signers(1, 3)))),
      ).toMatchObject({
        code: CODE.INVALID_SIGNING_ORDER,
        details: {
          reason: 'NOT_CONSECUTIVE',
          expected: [1, 2],
          received: [1, 3],
        },
      });
    });

    it('un documento no secuencial puede omitir el orden', () => {
      expect(() =>
        validator().validatePayload(
          payload((value) => {
            signers(undefined, undefined)(value);
            value.document.isSequential = false;
          }),
        ),
      ).not.toThrow();
    });

    it('el orden de los testigos no cuenta', () => {
      expect(() =>
        validator().validatePayload(
          payload((value) => {
            value.participants = [
              signer('s@correo.com', 1),
              witness('t@correo.com', { order: 1 }),
            ];
          }),
        ),
      ).not.toThrow();
    });
  });

  describe('posiciones de firma', () => {
    it.each([
      ['una página 0', { page: 0 }, 'page'],
      ['una página no entera', { page: 1.5 }, 'page'],
      ['un xRatio mayor que 1', { xRatio: 1.2 }, 'xRatio'],
      ['un yRatio negativo', { yRatio: -0.1 }, 'yRatio'],
      ['un ancho de 0', { widthRatio: 0 }, 'widthRatio'],
      ['un alto negativo', { heightRatio: -0.1 }, 'heightRatio'],
    ])(
      'rechaza %s con INVALID_SIGNATURE_POSITION',
      (_label, overrides, property) => {
        expect(
          errorOf(() =>
            validator().validatePayload(
              payload(
                (value) =>
                  (value.participants[0].signaturePositions = [
                    position(overrides),
                  ]),
              ),
            ),
          ),
        ).toMatchObject({
          code: CODE.INVALID_SIGNATURE_POSITION,
          details: {
            field: `participants[0].signaturePositions[0].${property}`,
          },
        });
      },
    );

    describe('contra el PDF', () => {
      function validated(patch: (value: Plain) => void) {
        return validator().validatePayload(payload(patch));
      }

      it('acepta posiciones que caben en el documento', () => {
        expect(() =>
          validator().assertPositionsFitDocument(
            validated(() => {}),
            1,
          ),
        ).not.toThrow();
      });

      it('rechaza una página que el PDF no tiene', () => {
        const parsed = validated(
          (value) =>
            (value.participants[0].signaturePositions = [
              position(),
              position({ page: 4 }),
            ]),
        );

        expect(
          errorOf(() => validator().assertPositionsFitDocument(parsed, 3)),
        ).toEqual({
          statusCode: 422,
          code: CODE.SIGNATURE_POSITION_PAGE_OUT_OF_RANGE,
          message:
            'La posición de firma está en la página 4, pero el documento sólo tiene 3.',
          details: {
            field: 'participants[0].signaturePositions[1].page',
            page: 4,
            totalPages: 3,
          },
        });
      });

      it('rechaza una caja que se sale de la página', () => {
        const parsed = validated(
          (value) =>
            (value.participants[0].signaturePositions = [
              position({ xRatio: 0.9, widthRatio: 0.2 }),
            ]),
        );

        expect(
          errorOf(() => validator().assertPositionsFitDocument(parsed, 1)),
        ).toMatchObject({
          code: CODE.INVALID_SIGNATURE_POSITION,
          details: {
            field: 'participants[0].signaturePositions[0]',
            reason: 'OUT_OF_PAGE_BOUNDS',
          },
        });
      });

      it('rechaza posiciones traslapadas entre firmantes distintos, con los dos campos', () => {
        const parsed = validated((value) => {
          value.participants = [
            signer('a@correo.com', 1, { signaturePositions: [position()] }),
            signer('b@correo.com', 2, {
              signaturePositions: [position({ xRatio: 0.2 })],
            }),
          ];
        });

        expect(
          errorOf(() => validator().assertPositionsFitDocument(parsed, 1)),
        ).toMatchObject({
          code: CODE.SIGNATURE_POSITION_OVERLAP,
          details: {
            field: 'participants[1].signaturePositions[0]',
            fields: [
              'participants[0].signaturePositions[0]',
              'participants[1].signaturePositions[0]',
            ],
            page: 1,
          },
        });
      });

      it('las mismas cajas en páginas distintas no se traslapan', () => {
        const parsed = validated((value) => {
          value.participants = [
            signer('a@correo.com', 1, { signaturePositions: [position()] }),
            signer('b@correo.com', 2, {
              signaturePositions: [position({ page: 2 })],
            }),
          ];
        });

        expect(() =>
          validator().assertPositionsFitDocument(parsed, 2),
        ).not.toThrow();
      });
    });
  });
});

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CollaboratorPayloadDto,
  PAYLOAD_COLABORATOR_TYPE_ENUM,
} from './create-document-signatures.dto';

function baseViewer(overrides: Record<string, unknown> = {}) {
  return {
    collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.VIEWER,
    firstName: 'Ana',
    lastName: 'Ruiz',
    email: 'ana@correo.com',
    ...overrides,
  };
}

async function validateDto(payload: unknown) {
  const dto = plainToInstance(CollaboratorPayloadDto, payload);
  return validate(dto);
}

function errorsFor(
  errors: Awaited<ReturnType<typeof validateDto>>,
  property: string,
) {
  return errors.filter((error) => error.property === property);
}

/**
 * El campo se llamaba `rfc` hasta la historia "Estandarizar campos de colaboradores"; la regla de
 * validación es la misma y sólo cambió el nombre.
 *
 * Historia "Eliminar campo RFC de la sección de Espectadores": antes era obligatorio SOLO para
 * VIEWER; ahora es opcional también para VIEWER, pero si llega con valor se sigue validando como
 * string.
 */
describe('CollaboratorPayloadDto.taxId', () => {
  it.each([
    ['sin el campo', baseViewer()],
    ['en null', baseViewer({ taxId: null })],
    ['vacío', baseViewer({ taxId: '' })],
  ])('acepta un VIEWER %s de taxId', async (_name, payload) => {
    const errors = await validateDto(payload);

    expect(errorsFor(errors, 'taxId')).toHaveLength(0);
  });

  it('acepta un VIEWER con taxId válido', async () => {
    const errors = await validateDto(baseViewer({ taxId: 'AURU800101ABC' }));

    expect(errorsFor(errors, 'taxId')).toHaveLength(0);
  });

  it('rechaza un VIEWER cuyo taxId no es un string', async () => {
    const errors = await validateDto(baseViewer({ taxId: 12345 }));

    expect(errorsFor(errors, 'taxId').length).toBeGreaterThan(0);
  });

  it('nunca valida el taxId de un SIGNER, aunque venga mal tipado', async () => {
    const errors = await validateDto({
      collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER,
      firstName: 'Juan',
      lastName: 'Pérez',
      email: 'juan@correo.com',
      taxId: 12345,
    });

    expect(errorsFor(errors, 'taxId')).toHaveLength(0);
  });

  /**
   * El nombre viejo deja de existir como campo del contrato: `whitelist: true` del
   * `ValidationPipe` global lo descarta antes de llegar al caso de uso, así que un cliente que
   * siga mandando `rfc` no reintroduce el dato por la puerta de atrás — simplemente no lo manda.
   */
  it('ignora por completo un `rfc` heredado en el payload', async () => {
    const errors = await validateDto(baseViewer({ rfc: 'AURU800101ABC' }));
    const dto = plainToInstance(
      CollaboratorPayloadDto,
      baseViewer({ rfc: 'AURU800101ABC' }),
    );

    expect(errorsFor(errors, 'rfc')).toHaveLength(0);
    expect(dto.taxId).toBeUndefined();
  });
});

/**
 * Historia "Hacer obligatorias las coordenadas de posición de firma": cada SIGNER trae al menos
 * una posición y cada posición tiene un tamaño real; a un VIEWER no se le exige nada.
 */
describe('CollaboratorPayloadDto.signatures', () => {
  function baseSigner(overrides: Record<string, unknown> = {}) {
    return {
      collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER,
      firstName: 'Juan',
      lastName: 'Pérez',
      email: 'juan@correo.com',
      signatures: [
        {
          page: 1,
          xRatio: 0.1,
          yRatio: 0.1,
          widthRatio: 0.2,
          heightRatio: 0.08,
        },
      ],
      ...overrides,
    };
  }

  it('acepta un SIGNER con al menos una posición válida', async () => {
    const errors = await validateDto(baseSigner());

    expect(errorsFor(errors, 'signatures')).toHaveLength(0);
  });

  it.each([
    ['sin el campo', { signatures: undefined }],
    ['con el arreglo vacío', { signatures: [] }],
  ])(
    'rechaza un SIGNER %s con un mensaje que pide la ubicación',
    async (_name, overrides) => {
      const [error] = errorsFor(
        await validateDto(baseSigner(overrides)),
        'signatures',
      );

      expect(Object.values(error.constraints ?? {})).toContain(
        'Es obligatorio indicar la ubicación de la firma de cada firmante',
      );
    },
  );

  it('rechaza un SIGNER cuya posición no es un arreglo', async () => {
    const errors = await validateDto(baseSigner({ signatures: 'arriba' }));

    expect(errorsFor(errors, 'signatures').length).toBeGreaterThan(0);
  });

  it.each([
    ['un ancho de 0', { widthRatio: 0 }],
    ['un alto de 0', { heightRatio: 0 }],
    ['un ratio mayor que 1', { xRatio: 1.2 }],
    ['una página 0', { page: 0 }],
    ['un ratio que no es número', { yRatio: 'abajo' }],
  ])('rechaza una posición con %s', async (_name, override) => {
    const errors = await validateDto(
      baseSigner({
        signatures: [
          {
            page: 1,
            xRatio: 0.1,
            yRatio: 0.1,
            widthRatio: 0.2,
            heightRatio: 0.08,
            ...override,
          },
        ],
      }),
    );

    expect(errorsFor(errors, 'signatures').length).toBeGreaterThan(0);
  });

  it('no exige posiciones a un VIEWER', async () => {
    const errors = await validateDto(baseViewer());

    expect(errorsFor(errors, 'signatures')).toHaveLength(0);
  });
});

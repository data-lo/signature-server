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

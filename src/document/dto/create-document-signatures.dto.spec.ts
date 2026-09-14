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

/**
 * Historia "Eliminar campo RFC de la sección de Espectadores": antes `rfc` era obligatorio SOLO
 * para VIEWER; ahora es opcional también para VIEWER, pero si llega con valor se sigue validando
 * como string.
 */
describe('CollaboratorPayloadDto.rfc', () => {
  it.each([
    ['sin el campo', baseViewer()],
    ['en null', baseViewer({ rfc: null })],
    ['vacío', baseViewer({ rfc: '' })],
  ])('acepta un VIEWER %s de rfc', async (_name, payload) => {
    const errors = await validateDto(payload);
    const rfcErrors = errors.filter((error) => error.property === 'rfc');
    expect(rfcErrors).toHaveLength(0);
  });

  it('acepta un VIEWER con rfc válido', async () => {
    const errors = await validateDto(baseViewer({ rfc: 'AURU800101ABC' }));
    const rfcErrors = errors.filter((error) => error.property === 'rfc');
    expect(rfcErrors).toHaveLength(0);
  });

  it('rechaza un VIEWER cuyo rfc no es un string', async () => {
    const errors = await validateDto(baseViewer({ rfc: 12345 }));
    const rfcErrors = errors.filter((error) => error.property === 'rfc');
    expect(rfcErrors.length).toBeGreaterThan(0);
  });

  it('nunca valida el rfc de un SIGNER, aunque venga mal tipado', async () => {
    const errors = await validateDto({
      collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER,
      firstName: 'Juan',
      lastName: 'Pérez',
      email: 'juan@correo.com',
      rfc: 12345,
    });
    const rfcErrors = errors.filter((error) => error.property === 'rfc');
    expect(rfcErrors).toHaveLength(0);
  });
});

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CollaboratorPayloadDto,
  PAYLOAD_COLABORATOR_TYPE_ENUM,
  PAYLOAD_COLLABORATOR_SOURCE_ENUM,
  collaboratorSourceViolations,
  forbiddenFieldsForSource,
} from './create-document-signatures.dto';

function baseWitness(overrides: Record<string, unknown> = {}) {
  return {
    source: PAYLOAD_COLLABORATOR_SOURCE_ENUM.MANUAL,
    addToDirectory: false,
    collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.WITNESS,
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
    ['sin el campo', baseWitness()],
    ['en null', baseWitness({ taxId: null })],
    ['vacío', baseWitness({ taxId: '' })],
  ])('acepta un VIEWER %s de taxId', async (_name, payload) => {
    const errors = await validateDto(payload);

    expect(errorsFor(errors, 'taxId')).toHaveLength(0);
  });

  it('acepta un VIEWER con taxId válido', async () => {
    const errors = await validateDto(baseWitness({ taxId: 'AURU800101ABC' }));

    expect(errorsFor(errors, 'taxId')).toHaveLength(0);
  });

  it('rechaza un VIEWER cuyo taxId no es un string', async () => {
    const errors = await validateDto(baseWitness({ taxId: 12345 }));

    expect(errorsFor(errors, 'taxId').length).toBeGreaterThan(0);
  });

  it('nunca valida el taxId de un SIGNER, aunque venga mal tipado', async () => {
    const errors = await validateDto({
      source: PAYLOAD_COLLABORATOR_SOURCE_ENUM.MANUAL,
      addToDirectory: false,
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
    const errors = await validateDto(baseWitness({ rfc: 'AURU800101ABC' }));
    const dto = plainToInstance(
      CollaboratorPayloadDto,
      baseWitness({ rfc: 'AURU800101ABC' }),
    );

    expect(errorsFor(errors, 'rfc')).toHaveLength(0);
    expect(dto.taxId).toBeUndefined();
  });
});

/**
 * Historia "Renombrar rol Espectador a Testigo": el payload identifica al testigo con `WITNESS`.
 * `VIEWER`, el valor anterior, se sigue aceptando y se traduce, para no romper a un cliente
 * desplegado antes del cambio.
 */
describe('CollaboratorPayloadDto.collaboratorType', () => {
  function witness(collaboratorType: unknown) {
    return { ...baseWitness(), collaboratorType };
  }

  it('acepta WITNESS', async () => {
    const errors = await validateDto(witness('WITNESS'));

    expect(errorsFor(errors, 'collaboratorType')).toHaveLength(0);
  });

  it('traduce el valor anterior VIEWER a WITNESS', async () => {
    const dto = plainToInstance(CollaboratorPayloadDto, witness('VIEWER'));
    const errors = await validate(dto);

    expect(errorsFor(errors, 'collaboratorType')).toHaveLength(0);
    expect(dto.collaboratorType).toBe(PAYLOAD_COLABORATOR_TYPE_ENUM.WITNESS);
  });

  it.each(['WATCHER', 'witness', 'SPECTATOR'])(
    'rechaza %s',
    async (collaboratorType) => {
      const errors = await validateDto(witness(collaboratorType));

      expect(errorsFor(errors, 'collaboratorType').length).toBeGreaterThan(0);
    },
  );
});

/**
 * Historia "Implementar creación transaccional de colaboradores desde Directorio y captura
 * manual": `source` es obligatorio y decide qué campos se exigen y cuáles se rechazan.
 */
describe('CollaboratorPayloadDto.source', () => {
  const LINKED_USER_ID = '6a1f2c4e-8d3b-4f7a-9c2e-1b5d7e9f0a3c';

  const directory = (overrides: Record<string, unknown> = {}) => ({
    source: PAYLOAD_COLLABORATOR_SOURCE_ENUM.DIRECTORY,
    collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.WITNESS,
    linkedUserId: LINKED_USER_ID,
    ...overrides,
  });

  it('un colaborador DIRECTORY válido sólo trae linkedUserId', async () => {
    expect(await validateDto(directory())).toHaveLength(0);
  });

  it('un colaborador MANUAL válido trae nombre, apellido, correo y addToDirectory', async () => {
    expect(
      await validateDto(baseWitness({ addToDirectory: true })),
    ).toHaveLength(0);
  });

  it.each([
    ['sin linkedUserId', { linkedUserId: undefined }, 'linkedUserId'],
    [
      'con un linkedUserId que no es UUID',
      { linkedUserId: 'user-1' },
      'linkedUserId',
    ],
  ])('rechaza un DIRECTORY %s', async (_case, overrides, property) => {
    const errors = await validateDto(directory(overrides));

    expect(errorsFor(errors, property).length).toBeGreaterThan(0);
  });

  it.each([
    ['firstName', { firstName: 'Impostor' }],
    ['lastName', { lastName: 'X' }],
    ['email', { email: 'impostor@evil.com' }],
    ['addToDirectory', { addToDirectory: false }],
  ])('rechaza un DIRECTORY que trae %s', async (field, overrides) => {
    const [error] = errorsFor(
      await validateDto(directory(overrides)),
      'source',
    );

    expect(Object.values(error.constraints ?? {})).toEqual([
      `Con source DIRECTORY no se aceptan: ${field}`,
    ]);
  });

  it.each([
    ['firstName', { firstName: undefined }],
    ['lastName', { lastName: undefined }],
    ['email', { email: undefined }],
    ['addToDirectory', { addToDirectory: undefined }],
  ])('rechaza un MANUAL sin %s', async (field, overrides) => {
    const errors = await validateDto(baseWitness(overrides));

    expect(errorsFor(errors, field).length).toBeGreaterThan(0);
  });

  it('rechaza un MANUAL que trae linkedUserId', async () => {
    const [error] = errorsFor(
      await validateDto(baseWitness({ linkedUserId: LINKED_USER_ID })),
      'source',
    );

    expect(Object.values(error.constraints ?? {})).toEqual([
      'Con source MANUAL no se aceptan: linkedUserId',
    ]);
  });

  it.each([
    ['ausente', undefined],
    ['desconocido', 'CRM'],
  ])('rechaza un source %s', async (_case, source) => {
    const errors = await validateDto(baseWitness({ source }));

    expect(errorsFor(errors, 'source').length).toBeGreaterThan(0);
  });

  it('rechaza un addToDirectory que no es booleano', async () => {
    const errors = await validateDto(baseWitness({ addToDirectory: 'sí' }));

    expect(errorsFor(errors, 'addToDirectory').length).toBeGreaterThan(0);
  });
});

describe('collaboratorSourceViolations', () => {
  it('reúne en un mensaje lo que falta y en otro lo que sobra', () => {
    expect(
      collaboratorSourceViolations({
        source: PAYLOAD_COLLABORATOR_SOURCE_ENUM.MANUAL,
        firstName: 'Ana',
        linkedUserId: 'user-1',
      }),
    ).toEqual([
      'Con source MANUAL son obligatorios: lastName, email, addToDirectory',
      'Con source MANUAL no se aceptan: linkedUserId',
    ]);
  });

  it('un null explícito en un campo ajeno al origen también cuenta como enviado', () => {
    expect(
      forbiddenFieldsForSource({
        source: PAYLOAD_COLLABORATOR_SOURCE_ENUM.DIRECTORY,
        linkedUserId: 'user-1',
        email: null as unknown as string,
      }),
    ).toEqual(['email']);
  });

  it('no reporta nada para un colaborador coherente', () => {
    expect(
      collaboratorSourceViolations({
        source: PAYLOAD_COLLABORATOR_SOURCE_ENUM.DIRECTORY,
        linkedUserId: 'user-1',
      }),
    ).toEqual([]);
  });
});

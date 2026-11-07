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
 * Historia "Eliminar campo RFC de la sección de Testigos": `taxId` (y su nombre anterior, `rfc`)
 * dejaron de existir en el contrato. Un cliente viejo que los siga mandando no recibe un error:
 * `whitelist: true` del `ValidationPipe` global los descarta antes de llegar al caso de uso.
 */
describe('CollaboratorPayloadDto sin identificador fiscal', () => {
  it('acepta un testigo sin RFC', async () => {
    expect(await validateDto(baseWitness())).toHaveLength(0);
  });

  it.each([
    ['taxId', 12345],
    ['taxId', 'AURU800101ABC'],
    ['rfc', 'AURU800101ABC'],
  ])('descarta sin validarlo un %s heredado (%s)', async (field, value) => {
    const dto = plainToInstance(
      CollaboratorPayloadDto,
      baseWitness({ [field]: value }),
    );

    const errors = await validate(dto, { whitelist: true });

    expect(errors).toHaveLength(0);
    expect(dto).not.toHaveProperty(field);
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

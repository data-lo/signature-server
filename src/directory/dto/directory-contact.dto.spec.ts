import { ValidationPipe } from '@nestjs/common';

import { CreateDirectoryContactDto } from './create-directory-contact.dto';
import { SearchDirectoryContactsDto } from './search-directory-contacts.dto';
import { UpdateDirectoryContactDto } from './update-directory-contact.dto';

/**
 * Se valida con el mismo `ValidationPipe` que `main.ts` (`whitelist` + `transform`): lo que se
 * prueba es lo que de verdad llega al servicio, incluida la propiedad descartada.
 */
const pipe = new ValidationPipe({ whitelist: true, transform: true });

function validate<T>(
  metatype: new () => T,
  value: unknown,
  type: 'body' | 'query' = 'body',
): Promise<T> {
  return pipe.transform(value, { type, metatype }) as Promise<T>;
}

describe('CreateDirectoryContactDto', () => {
  it('recorta los campos y descarta accountId, organizationId y directoryId', async () => {
    const dto = await validate(CreateDirectoryContactDto, {
      firstName: '  Ana ',
      lastName: ' García ',
      email: ' ana@example.com ',
      accountId: 'acc-ajena',
      organizationId: 'org-ajena',
      directoryId: 'dir-ajeno',
    });

    expect({ ...dto }).toEqual({
      firstName: 'Ana',
      lastName: 'García',
      email: 'ana@example.com',
    });
  });

  it.each([
    ['sin nombre', { lastName: 'García', email: 'ana@example.com' }],
    [
      'con el nombre en blanco',
      { firstName: '   ', lastName: 'García', email: 'ana@example.com' },
    ],
    [
      'con un correo inválido',
      { firstName: 'Ana', lastName: 'García', email: 'ana' },
    ],
  ])('rechaza el alta %s', async (_case, body) => {
    await expect(validate(CreateDirectoryContactDto, body)).rejects.toThrow();
  });
});

describe('UpdateDirectoryContactDto', () => {
  it('acepta un cambio parcial y descarta los identificadores de dueño', async () => {
    const dto = await validate(UpdateDirectoryContactDto, {
      lastName: 'García Soto',
      organizationId: 'org-ajena',
    });

    expect({ ...dto }).toEqual({ lastName: 'García Soto' });
  });

  it.each(['firstName', 'lastName', 'email'])(
    'rechaza %s en null: es obligatorio en la entidad',
    async (field) => {
      await expect(
        validate(UpdateDirectoryContactDto, { [field]: null }),
      ).rejects.toThrow();
    },
  );
});

describe('SearchDirectoryContactsDto', () => {
  it('acepta un fragmento de correo, que no tiene por qué ser un correo válido', async () => {
    const dto = await validate(
      SearchDirectoryContactsDto,
      { email: ' garcia ', limit: '10' },
      'query',
    );

    expect(dto).toMatchObject({ email: 'garcia', limit: 10 });
  });

  it.each([
    ['sin email', {}],
    ['con email vacío', { email: '  ' }],
    ['con un límite fuera de rango', { email: 'a', limit: '101' }],
  ])('rechaza la búsqueda %s', async (_case, query) => {
    await expect(
      validate(SearchDirectoryContactsDto, query, 'query'),
    ).rejects.toThrow();
  });
});

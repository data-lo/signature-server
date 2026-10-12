import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateDirectoryContactDto } from './create-directory-contact.dto';
import { UpdateDirectoryContactDto } from './update-directory-contact.dto';

async function errorsOf<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
): Promise<{ dto: T; fields: string[] }> {
  const dto = plainToInstance(cls, payload);
  const errors = await validate(dto);
  return { dto, fields: errors.map((error) => error.property) };
}

describe('CreateDirectoryContactDto', () => {
  const valid = {
    firstName: ' Ana ',
    lastName: 'García',
    email: ' ana@example.com ',
  };

  it('acepta el alta mínima y recorta los textos', async () => {
    const { dto, fields } = await errorsOf(CreateDirectoryContactDto, valid);

    expect(fields).toEqual([]);
    expect(dto.firstName).toBe('Ana');
    expect(dto.email).toBe('ana@example.com');
  });

  it('exige nombre, apellido y un correo válido', async () => {
    const { fields } = await errorsOf(CreateDirectoryContactDto, {
      firstName: '   ',
      email: 'no-es-correo',
    });

    expect(fields.sort()).toEqual(['email', 'firstName', 'lastName']);
  });

  it('convierte RFC y teléfono vacíos en null', async () => {
    const { dto, fields } = await errorsOf(CreateDirectoryContactDto, {
      ...valid,
      taxId: '  ',
      phone: '',
    });

    expect(fields).toEqual([]);
    expect(dto.taxId).toBeNull();
    expect(dto.phone).toBeNull();
  });

  it('rechaza un RFC de más de 13 caracteres', async () => {
    const { fields } = await errorsOf(CreateDirectoryContactDto, {
      ...valid,
      taxId: 'GAAA900101XXXX',
    });

    expect(fields).toEqual(['taxId']);
  });
});

describe('UpdateDirectoryContactDto', () => {
  it('acepta el cuerpo vacío', async () => {
    expect((await errorsOf(UpdateDirectoryContactDto, {})).fields).toEqual([]);
  });

  /** Con `@IsOptional`, un `null` llegaría hasta una columna NOT NULL y respondería 500. */
  it('no deja vaciar nombre, apellido ni correo con null', async () => {
    const { fields } = await errorsOf(UpdateDirectoryContactDto, {
      firstName: null,
      lastName: null,
      email: null,
    });

    expect(fields.sort()).toEqual(['email', 'firstName', 'lastName']);
  });

  it('deja vaciar RFC y teléfono con null', async () => {
    const { dto, fields } = await errorsOf(UpdateDirectoryContactDto, {
      taxId: null,
      phone: null,
    });

    expect(fields).toEqual([]);
    expect(dto.taxId).toBeNull();
    expect(dto.phone).toBeNull();
  });
});

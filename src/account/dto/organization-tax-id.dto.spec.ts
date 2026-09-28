import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateAccountDto } from './create-account.dto';
import { CreateOrganizationDto } from './create-organization.dto';
import { UpdateAccountDto } from './update-account.dto';
import { ACCOUNT_TYPE_ENUM } from '../enums/account-type.enum';

/**
 * El identificador fiscal de la organización se llamaba `rfc` hasta la historia "Renombrar campo
 * RFC a taxId en Organización"; la regla es la misma (opcional, y si llega, string) y sólo cambió
 * el nombre.
 *
 * `main.ts` monta el `ValidationPipe` con `whitelist: true` y sin `forbidNonWhitelisted`, así que
 * un cliente que siga mandando `rfc` no recibe un 400: el campo se descarta en silencio. Las
 * pruebas de `whitelist` lo dejan fijado para que el cambio de contrato no pase desapercibido.
 */
const DTO_CASES = [
  {
    label: 'CreateOrganizationDto',
    dtoClass: CreateOrganizationDto,
    base: { name: 'Acme', organizationName: 'Acme Corp S.A. de C.V.' },
  },
  {
    label: 'CreateAccountDto',
    dtoClass: CreateAccountDto,
    base: {
      name: 'Acme',
      type: ACCOUNT_TYPE_ENUM.ORGANIZATION,
      organizationName: 'Acme Corp S.A. de C.V.',
    },
  },
  { label: 'UpdateAccountDto', dtoClass: UpdateAccountDto, base: {} },
] as const;

describe.each(DTO_CASES)('$label.taxId', ({ dtoClass, base }) => {
  async function errorsForTaxId(payload: Record<string, unknown>) {
    const errors = await validate(plainToInstance(dtoClass, payload));
    return errors.filter((error) => error.property === 'taxId');
  }

  it('acepta el payload sin taxId', async () => {
    expect(await errorsForTaxId({ ...base })).toHaveLength(0);
  });

  it('acepta taxId como string', async () => {
    expect(
      await errorsForTaxId({ ...base, taxId: 'ACM010101AAA' }),
    ).toHaveLength(0);
  });

  it('rechaza taxId que no es string', async () => {
    expect(await errorsForTaxId({ ...base, taxId: 12345 })).toHaveLength(1);
  });

  it('conserva taxId y descarta el rfc legado con whitelist', async () => {
    const dto = plainToInstance(dtoClass, {
      ...base,
      taxId: 'ACM010101AAA',
      rfc: 'XAXX010101000',
    });

    const errors = await validate(dto, { whitelist: true });

    expect(errors).toHaveLength(0);
    expect(dto).toMatchObject({ taxId: 'ACM010101AAA' });
    expect(dto).not.toHaveProperty('rfc');
  });
});

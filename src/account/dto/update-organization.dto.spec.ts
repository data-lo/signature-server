import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateOrganizationDto } from './update-organization.dto';

/**
 * Se transforma y valida como lo hace el `ValidationPipe` de `main.ts` (`transform: true`,
 * `whitelist: true`): lo que se prueba es lo que de verdad llega al caso de uso.
 */
async function parse(payload: Record<string, unknown>) {
  const dto = plainToInstance(UpdateOrganizationDto, payload);
  const errors = await validate(dto, { whitelist: true });
  return { dto, properties: errors.map((error) => error.property) };
}

describe('UpdateOrganizationDto', () => {
  it('acepta un body vacío: todo es opcional', async () => {
    expect((await parse({})).properties).toEqual([]);
  });

  it('acepta un perfil completo y válido', async () => {
    const { properties } = await parse({
      displayName: 'Acme',
      name: 'Acme Corp S.A. de C.V.',
      taxId: 'ACM010101AAA',
      phoneNumber: '5512345678',
      address: 'Av. Reforma 123, CDMX',
      domainAllowed: 'acme.com',
    });

    expect(properties).toEqual([]);
  });

  describe('nombres', () => {
    it.each(['displayName', 'name'])(
      'rechaza %s vacío o en blanco',
      async (field) => {
        expect((await parse({ [field]: '   ' })).properties).toEqual([field]);
      },
    );

    it.each(['displayName', 'name'])('rechaza %s en null', async (field) => {
      expect((await parse({ [field]: null })).properties).toEqual([field]);
    });

    it('recorta los espacios', async () => {
      const { dto } = await parse({ displayName: '  Acme  ' });
      expect(dto.displayName).toBe('Acme');
    });

    it('rechaza nombres de más de 255 caracteres', async () => {
      expect((await parse({ name: 'a'.repeat(256) })).properties).toEqual([
        'name',
      ]);
    });
  });

  describe('taxId', () => {
    it.each(['ACM010101AAA', 'PELJ850101AB1', 'Ñ&A010101AAA'])(
      'acepta el RFC %s',
      async (taxId) => {
        expect((await parse({ taxId })).properties).toEqual([]);
      },
    );

    it('lo guarda en mayúsculas', async () => {
      const { dto, properties } = await parse({ taxId: ' acm010101aaa ' });
      expect(properties).toEqual([]);
      expect(dto.taxId).toBe('ACM010101AAA');
    });

    it.each(['ACM0101', 'ACM010101AAAA1', '123010101AAA', 'ACM-010101-AAA'])(
      'rechaza %s',
      async (taxId) => {
        expect((await parse({ taxId })).properties).toEqual(['taxId']);
      },
    );
  });

  describe('phoneNumber', () => {
    it.each(['55 1234 5678', '123456', '1234567890123456', '+525512345678'])(
      'rechaza %s',
      async (phoneNumber) => {
        expect((await parse({ phoneNumber })).properties).toEqual([
          'phoneNumber',
        ]);
      },
    );
  });

  describe('domainAllowed', () => {
    it.each(['acme.com', 'mx.acme.com.mx', 'ACME.COM'])(
      'acepta %s',
      async (domainAllowed) => {
        expect((await parse({ domainAllowed })).properties).toEqual([]);
      },
    );

    it('lo guarda en minúsculas', async () => {
      const { dto } = await parse({ domainAllowed: 'Acme.COM' });
      expect(dto.domainAllowed).toBe('acme.com');
    });

    it.each([
      '@acme.com',
      'https://acme.com',
      'acme',
      'acme..com',
      'correo@acme.com',
    ])('rechaza %s', async (domainAllowed) => {
      expect((await parse({ domainAllowed })).properties).toEqual([
        'domainAllowed',
      ]);
    });
  });

  it('rechaza un domicilio de más de 500 caracteres', async () => {
    expect((await parse({ address: 'a'.repeat(501) })).properties).toEqual([
      'address',
    ]);
  });

  /**
   * El formulario manda `''` al vaciar un campo. Guardar texto vacío dejaría un tercer estado que
   * la pantalla no distingue de "Sin capturar"; se normaliza a `null`, que es "bórralo".
   */
  it.each(['taxId', 'phoneNumber', 'address', 'domainAllowed'])(
    'convierte %s vacío en null',
    async (field) => {
      const { dto, properties } = await parse({ [field]: '  ' });
      expect(properties).toEqual([]);
      expect(dto[field as keyof UpdateOrganizationDto]).toBeNull();
    },
  );

  it.each([true, false])('acepta indexDocuments en %s', async (value) => {
    const { dto, properties } = await parse({ indexDocuments: value });

    expect(properties).toEqual([]);
    expect(dto.indexDocuments).toBe(value);
  });

  /** A diferencia de los opcionales de texto, el interruptor no se "borra": es sí o no. */
  it.each([null, 'false', 1])(
    'rechaza indexDocuments que no es booleano (%p)',
    async (value) => {
      const { properties } = await parse({ indexDocuments: value });
      expect(properties).toEqual(['indexDocuments']);
    },
  );
});

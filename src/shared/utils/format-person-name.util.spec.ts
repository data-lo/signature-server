import {
  formatOptionalPersonName,
  formatPersonName,
} from './format-person-name.util';

describe('formatPersonName', () => {
  it.each([
    ['juan pérez', 'Juan Pérez'],
    ['MARÍA DEL CARMEN', 'María Del Carmen'],
    ['  ana   lopez  ', 'Ana Lopez'],
  ])('normaliza %s a %s', (input, expected) => {
    expect(formatPersonName(input)).toBe(expected);
  });

  describe('nombres y apellidos compuestos', () => {
    it('capitaliza cada palabra de un nombre compuesto', () => {
      expect(formatPersonName('juan carlos')).toBe('Juan Carlos');
    });

    it('capitaliza cada palabra de un apellido compuesto', () => {
      expect(formatPersonName('de la cruz mendoza')).toBe('De La Cruz Mendoza');
    });

    /**
     * Las partículas no son excepción: es lo que pide la historia y lo único que se puede
     * decidir sin conocer al titular (ver el docblock del util).
     */
    it('no trata las partículas como excepción', () => {
      expect(formatPersonName('MARÍA DE LOS ÁNGELES')).toBe(
        'María De Los Ángeles',
      );
    });
  });

  describe('valores en mayúsculas', () => {
    it('baja a minúscula el resto de cada palabra', () => {
      expect(formatPersonName('ISAAY SOSA')).toBe('Isaay Sosa');
    });

    it('conserva los acentos al bajar de mayúscula', () => {
      expect(formatPersonName('JOSÉ MUÑOZ')).toBe('José Muñoz');
    });

    it('respeta la ñ en ambas direcciones', () => {
      expect(formatPersonName('nuñez')).toBe('Nuñez');
      expect(formatPersonName('PEÑA')).toBe('Peña');
    });
  });

  describe('espacios adicionales', () => {
    it('elimina los espacios iniciales y finales', () => {
      expect(formatPersonName('   Ana   ')).toBe('Ana');
    });

    it('colapsa los espacios consecutivos entre palabras', () => {
      expect(formatPersonName('ana     maria     lopez')).toBe(
        'Ana Maria Lopez',
      );
    });

    /** Tabuladores y saltos de línea llegan al pegar desde otra aplicación. */
    it('trata cualquier espacio en blanco como separador', () => {
      expect(formatPersonName('ana\tmaria\nlopez')).toBe('Ana Maria Lopez');
    });

    it('un valor de puros espacios queda vacío', () => {
      expect(formatPersonName('   ')).toBe('');
    });
  });

  /** Se aplica al guardar y al reenviar el mismo valor: no puede degradarlo. */
  it('es idempotente', () => {
    expect(formatPersonName(formatPersonName('MARÍA DEL CARMEN'))).toBe(
      'María Del Carmen',
    );
  });

  it('deja intacto un valor ya normalizado', () => {
    expect(formatPersonName('Juan Pérez')).toBe('Juan Pérez');
  });
});

describe('formatOptionalPersonName', () => {
  it('normaliza cuando hay valor', () => {
    expect(formatOptionalPersonName('juan pérez')).toBe('Juan Pérez');
  });

  /**
   * Una cadena vacía en la columna no significa lo mismo que "no se capturó": el alta con
   * nombre opcional tiene que poder dejarla sin escribir.
   */
  it.each([undefined, null, '', '   '])(
    'devuelve undefined para %p',
    (input) => {
      expect(formatOptionalPersonName(input)).toBeUndefined();
    },
  );
});

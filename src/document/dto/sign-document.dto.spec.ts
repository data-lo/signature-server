import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GeolocationDto, SignDocumentDto } from './sign-document.dto';

async function validateDto(payload: unknown) {
  const dto = plainToInstance(SignDocumentDto, payload);
  return validate(dto);
}

describe('SignDocumentDto', () => {
  /**
   * La geolocalización es obligatoria para firmar (antes era opcional: rechazar el permiso del
   * navegador dejaba pasar la firma sin ella). La validación vive en el servidor y no solo en la
   * UI, porque el bloqueo del cliente se evita llamando al endpoint directamente.
   */
  it.each([
    ['sin el campo geolocation', {}],
    ['geolocation en null', { geolocation: null }],
    ['geolocation en undefined', { geolocation: undefined }],
    ['geolocation como objeto vacío', { geolocation: {} }],
    ['geolocation como JSON inválido en el multipart', { geolocation: 'nope' }],
  ])('rechaza firmar %s', async (_name, payload) => {
    const errors = await validateDto(payload);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('el error de geolocalización faltante explica que es obligatoria', async () => {
    const errors = await validateDto({});
    const messages = JSON.stringify(errors);
    expect(messages).toMatch(/obligatoria/i);
  });

  it('acepta coordenadas válidas dentro de rango, con accuracy opcional', async () => {
    const errors = await validateDto({
      geolocation: { latitude: 19.4326, longitude: -99.1332, accuracy: 15 },
    });
    expect(errors).toHaveLength(0);
  });

  it('acepta coordenadas válidas sin accuracy', async () => {
    const errors = await validateDto({
      geolocation: { latitude: -90, longitude: 180 },
    });
    expect(errors).toHaveLength(0);
  });

  it.each([
    ['latitude fuera de rango (> 90)', { latitude: 91, longitude: 0 }],
    ['latitude fuera de rango (< -90)', { latitude: -91, longitude: 0 }],
    ['longitude fuera de rango (> 180)', { latitude: 0, longitude: 181 }],
    ['longitude fuera de rango (< -180)', { latitude: 0, longitude: -181 }],
    ['accuracy negativa', { latitude: 0, longitude: 0, accuracy: -1 }],
    ['latitude faltante', { longitude: 0 }],
    ['longitude faltante', { latitude: 0 }],
  ])('rechaza: %s', async (_name, geolocation) => {
    const errors = await validateDto({ geolocation });
    expect(errors.length).toBeGreaterThan(0);
  });

  /**
   * Bug encontrado en producción: este endpoint recibe multipart/form-data, donde multer entrega
   * `geolocation` como STRING JSON, no como objeto. Con `@Transform` devolviendo un objeto plano,
   * `@Type(() => GeolocationDto)` dejaba de aplicarse, y como consecuencia `@ValidateNested()` no
   * validaba nada (coordenadas fuera de rango se aceptaban) y el `whitelist: true` del
   * ValidationPipe global vaciaba el objeto, guardando `{}` como evidencia de ubicación.
   *
   * Los casos de arriba pasan el objeto ya parseado y por eso nunca detectaron el problema.
   */
  describe('geolocation como string JSON (lo que realmente llega por multipart/form-data)', () => {
    it('acepta coordenadas válidas y conserva sus valores', async () => {
      const payload = {
        geolocation: JSON.stringify({
          latitude: 19.4326,
          longitude: -99.1332,
          accuracy: 15,
        }),
      };
      const dto = plainToInstance(SignDocumentDto, payload);

      expect(await validate(dto)).toHaveLength(0);
      // Debe quedar una instancia con los valores intactos: si se pierden, se persiste `{}`.
      expect(dto.geolocation).toBeInstanceOf(GeolocationDto);
      expect(dto.geolocation).toEqual(
        expect.objectContaining({
          latitude: 19.4326,
          longitude: -99.1332,
          accuracy: 15,
        }),
      );
    });

    it.each([
      ['latitude fuera de rango', { latitude: 999, longitude: 0 }],
      ['longitude fuera de rango', { latitude: 0, longitude: -999 }],
      ['latitude faltante', { longitude: 0 }],
    ])('rechaza %s aunque venga serializado', async (_name, geolocation) => {
      const errors = await validateDto({
        geolocation: JSON.stringify(geolocation),
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SignDocumentDto } from './sign-document.dto';

async function validateDto(payload: unknown) {
  const dto = plainToInstance(SignDocumentDto, payload);
  return validate(dto);
}

describe('SignDocumentDto', () => {
  it('no reporta errores sin geolocalización (permiso rechazado o no disponible)', async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
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
});

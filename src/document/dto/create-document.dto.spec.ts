import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateDocumentDto } from './create-document.dto';

/**
 * `POST /document` (flujo anterior a `POST /documents/signatures`). Historia "Hacer obligatorias
 * las coordenadas de posición de firma": `signatureCoordinates` deja de ser opcional, y sin él ya
 * no se estampa en una posición por defecto que nadie eligió.
 */
describe('CreateDocumentDto.signatureCoordinates', () => {
  const coordinates = { x: 50, y: 250, width: 200, height: 80 };

  async function signatureCoordinatesErrors(signatureCoordinates: unknown) {
    const dto = plainToInstance(CreateDocumentDto, {
      signerIds: ['a1b2c3d4-e5f6-4890-abcd-ef1234567890'],
      signatureCoordinates,
    });
    const errors = await validate(dto);
    return errors.filter((error) => error.property === 'signatureCoordinates');
  }

  it('acepta coordenadas válidas, también serializadas como en multipart', async () => {
    expect(await signatureCoordinatesErrors(coordinates)).toHaveLength(0);
    expect(
      await signatureCoordinatesErrors(JSON.stringify(coordinates)),
    ).toHaveLength(0);
  });

  it('rechaza la petición sin coordenadas con un mensaje descriptivo', async () => {
    const [error] = await signatureCoordinatesErrors(undefined);

    expect(Object.values(error.constraints ?? {})).toContain(
      'Es obligatorio indicar la ubicación de la firma (signatureCoordinates)',
    );
  });

  it.each([
    ['un ancho de 0', { ...coordinates, width: 0 }],
    ['una coordenada negativa', { ...coordinates, x: -1 }],
    ['un valor que no es número', { ...coordinates, y: 'abajo' }],
  ])('rechaza coordenadas con %s', async (_name, value) => {
    expect((await signatureCoordinatesErrors(value)).length).toBeGreaterThan(0);
  });
});

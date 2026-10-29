import {
  ArgumentsHost,
  BadRequestException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  INCOMPLETE_UPLOAD_MESSAGE,
  MulterExceptionFilter,
} from './multer-exception.filter';

function buildHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('MulterExceptionFilter', () => {
  const filter = new MulterExceptionFilter(
    {} as HttpAdapterHost['httpAdapter'],
  );

  /**
   * Nest convierte los errores de busboy de un multipart cortado en `BadRequestException` con el
   * prefijo `Multipart: ` (ver `transformException`). Es lo que responde el backend cuando un
   * proxy trunca el cuerpo o la conexión se cae a mitad de la subida.
   */
  it.each([
    'Multipart: Unexpected end of form',
    'Multipart: Unexpected end of file',
    'Multipart: Malformed part header',
  ])(
    'traduce "%s" a un mensaje que invita a reintentar, con el mismo 400',
    (message) => {
      const { host, status, json } = buildHost();

      filter.catch(new BadRequestException(message), host);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({ message: INCOMPLETE_UPLOAD_MESSAGE }),
      );
    },
  );

  it('sigue traduciendo el rechazo por tamaño con su 413', () => {
    const { host, status, json } = buildHost();

    filter.catch(new PayloadTooLargeException('File too large'), host);

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('tamaño máximo'),
      }),
    );
  });
});

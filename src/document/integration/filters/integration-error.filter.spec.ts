import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import { InvalidApiKeyException } from 'src/api-key/exceptions/api-key.exceptions';
import { InsufficientDocumentCreditsException } from 'src/billing/exceptions/billing.exceptions';

import {
  INTEGRATION_VALIDATION_CODE_ENUM,
  IntegrationValidationException,
} from '../validation/integration-validation.exception';
import { IntegrationErrorFilter } from './integration-error.filter';

function run(exception: unknown) {
  const response = { status: jest.fn(), json: jest.fn() };
  response.status.mockReturnValue(response);
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;

  new IntegrationErrorFilter().catch(exception, host);

  return {
    status: response.status.mock.calls[0][0],
    body: response.json.mock.calls[0][0],
  };
}

describe('IntegrationErrorFilter', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('un error de validación conserva su 422, su código y sus detalles', () => {
    expect(
      run(
        new IntegrationValidationException(
          INTEGRATION_VALIDATION_CODE_ENUM.DUPLICATE_PARTICIPANT_EMAIL,
          'Un colaborador sólo puede participar una vez en el documento.',
          { field: 'participants[2].email', email: 'ana@correo.com' },
        ),
      ),
    ).toEqual({
      status: 422,
      body: {
        success: false,
        error: {
          code: 'DUPLICATE_PARTICIPANT_EMAIL',
          message:
            'Un colaborador sólo puede participar una vez en el documento.',
          details: { field: 'participants[2].email', email: 'ana@correo.com' },
        },
      },
    });
  });

  it('los errores con código de la API key conservan su estado y su código', () => {
    expect(run(new InvalidApiKeyException())).toEqual({
      status: 401,
      body: {
        success: false,
        error: {
          code: 'API_KEY_INVALID',
          message: 'API key inválida o revocada',
        },
      },
    });
  });

  it('un 400 del ValidationPipe pasa a 422 INVALID_REQUEST con las reglas incumplidas', () => {
    expect(
      run(new BadRequestException(['limit must not be greater than 100'])),
    ).toEqual({
      status: 422,
      body: {
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'La petición tiene campos inválidos.',
          details: { errors: ['limit must not be greater than 100'] },
        },
      },
    });
  });

  it.each([
    [new ForbiddenException('No puedes'), 403, 'FORBIDDEN'],
    [
      new InsufficientDocumentCreditsException(1, 0),
      402,
      'INSUFFICIENT_DOCUMENT_CREDITS',
    ],
    [new HttpException('Raro', 418), 418, 'HTTP_ERROR'],
  ])(
    'las demás excepciones HTTP reciben un código por estado',
    (exception, status, code) => {
      const { status: received, body } = run(exception);

      expect(received).toBe(status);
      expect(body).toMatchObject({ success: false, error: { code } });
    },
  );

  it.each([
    [
      'un error de TypeORM',
      new QueryFailedError(
        'SELECT * FROM users WHERE email = $1',
        ['ana@correo.com'],
        new Error('detalle del driver'),
      ),
    ],
    ['un error de MinIO', new Error('Error guardando archivo en bucket Minio')],
    ['algo que no es un Error', 'texto suelto'],
  ])('%s responde 500 genérico, sin detalles internos', (_label, exception) => {
    const { status, body } = run(exception);

    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Ocurrió un error interno. Vuelve a intentarlo más tarde.',
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /SELECT|driver|Minio|ana@correo|stack/i,
    );
  });
});

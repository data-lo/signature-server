import { ArgumentsHost, BadRequestException } from '@nestjs/common';

import {
  CertificateSubjectMismatchException,
  SIGNING_VALIDATION_ERROR_CODE_ENUM,
  SigningValidationException,
} from 'src/document/exceptions/signing-validation.exceptions';
import {
  CertificadoExpiradoException,
  CertificadoRevocadoException,
} from 'src/efirma/efirma.exceptions';

import { InvalidPublicSigningSessionException } from '../guards/public-signing-session.guard';
import {
  PublicSigningErrorFilter,
  signingErrorCode,
} from './public-signing-error.filter';

/** Ejecuta el filtro y devuelve el estado y el cuerpo de la respuesta. */
function render(exception: unknown) {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new PublicSigningErrorFilter().catch(exception, host);
  return {
    status: response.status.mock.calls[0][0],
    body: response.json.mock.calls[0][0],
  };
}

describe('PublicSigningErrorFilter', () => {
  it.each([
    [new CertificadoRevocadoException(), 'CERTIFICATE_REVOKED'],
    [new CertificadoExpiradoException(new Date()), 'CERTIFICATE_INVALID'],
    [new CertificateSubjectMismatchException(), 'CERTIFICATE_SUBJECT_MISMATCH'],
    [new InvalidPublicSigningSessionException(), 'SIGNING_SESSION_EXPIRED'],
    [new BadRequestException('x'), null],
    [new Error('x'), null],
  ])('signingErrorCode(%p) = %p', (error, code) => {
    expect(signingErrorCode(error)).toBe(code);
  });

  it('un error de validación sale con su código, estado y mensaje', () => {
    expect(
      render(
        new SigningValidationException(
          SIGNING_VALIDATION_ERROR_CODE_ENUM.IDENTITY_DATA_MISMATCH,
          'No corresponde.',
        ),
      ),
    ).toEqual({
      status: 403,
      body: {
        statusCode: 403,
        error: 'Forbidden',
        code: 'IDENTITY_DATA_MISMATCH',
        message: 'No corresponde.',
      },
    });
  });

  it('una excepción de la e.firma conserva su estado y gana su código', () => {
    const { status, body } = render(new CertificadoRevocadoException());
    expect(status).toBe(422);
    expect(body).toEqual(
      expect.objectContaining({ statusCode: 422, code: 'CERTIFICATE_REVOKED' }),
    );
  });

  it('cualquier otra HttpException sale con code null y su mensaje unido', () => {
    const { body } = render(new BadRequestException(['uno', 'dos']));
    expect(body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: null,
      message: 'uno, dos',
    });
  });

  it('un error no HTTP sale como 500 genérico, sin detalle', () => {
    const { status, body } = render(new Error('detalle interno'));
    expect(status).toBe(500);
    expect(body.code).toBeNull();
    expect(body.message).not.toContain('detalle interno');
  });
});

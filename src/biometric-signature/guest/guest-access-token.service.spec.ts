import { JwtService } from '@nestjs/jwt';
import { InvalidGuestAccessTokenException } from '../biometric-signature.exceptions';
import { GuestAccessTokenService } from './guest-access-token.service';

const JWT_SECRET = 'secreto-de-sesiones';

describe('GuestAccessTokenService', () => {
  let tokens: GuestAccessTokenService;

  beforeEach(() => {
    tokens = new GuestAccessTokenService({
      get: (key: string) => (key === 'JWT_SECRET' ? JWT_SECRET : undefined),
    } as never);
  });

  it('emite un token que acredita documento, colaborador y correo', () => {
    const { accessToken, expiresAt } = tokens.issue({
      documentId: 'd-1',
      collaboratorId: 'c-1',
      email: 'Ana@Correo.MX',
    });

    expect(tokens.verify(accessToken, 'd-1')).toEqual({
      documentId: 'd-1',
      collaboratorId: 'c-1',
      email: 'ana@correo.mx',
    });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('no sirve para otro documento', () => {
    const { accessToken } = tokens.issue({
      documentId: 'd-1',
      collaboratorId: 'c-1',
      email: 'ana@correo.mx',
    });

    expect(() => tokens.verify(accessToken, 'd-2')).toThrow(
      InvalidGuestAccessTokenException,
    );
  });

  it('rechaza un token ausente o alterado', () => {
    expect(() => tokens.verify(undefined, 'd-1')).toThrow(
      InvalidGuestAccessTokenException,
    );
    expect(() => tokens.verify('no-es-un-token', 'd-1')).toThrow(
      InvalidGuestAccessTokenException,
    );
  });

  it('un JWT de sesión (firmado con JWT_SECRET) no sirve como acceso de invitado', () => {
    const sessionToken = new JwtService({ secret: JWT_SECRET }).sign({
      purpose: 'biometric-signature-guest-access',
      documentId: 'd-1',
      collaboratorId: 'c-1',
      email: 'ana@correo.mx',
    });

    expect(() => tokens.verify(sessionToken, 'd-1')).toThrow(
      InvalidGuestAccessTokenException,
    );
  });

  it('y el token de invitado no verifica con JWT_SECRET: no sirve como sesión', () => {
    const { accessToken } = tokens.issue({
      documentId: 'd-1',
      collaboratorId: 'c-1',
      email: 'ana@correo.mx',
    });

    expect(() =>
      new JwtService({ secret: JWT_SECRET }).verify(accessToken),
    ).toThrow();
  });
});

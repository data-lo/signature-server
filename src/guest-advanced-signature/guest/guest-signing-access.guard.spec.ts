import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InvalidGuestSigningAccessException } from 'src/document/exceptions/guest-signing-access.exceptions';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from 'src/document/enum/guest-signing-access-purpose.enum';
import { GuestSigningTokenService } from './guest-signing-token.service';
import {
  GUEST_SIGNING_TOKEN_HEADER,
  GuestSigningAccessGuard,
} from './guest-signing-access.guard';

const PURPOSE =
  GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS;

/**
 * El token y el guard juntos: el token sólo identifica el acceso, y el guard exige además que esa
 * fila siga activa y sea del mismo documento y colaborador.
 */
describe('GuestSigningTokenService + GuestSigningAccessGuard', () => {
  const config = {
    get: () => 'jwt-secret-de-prueba',
  } as unknown as ConfigService;
  const tokens = new GuestSigningTokenService(config);
  const access = {
    id: 'acc-1',
    documentId: 'd-1',
    collaboratorId: 'c-1',
    purpose: PURPOSE,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  };
  let findActive: jest.Mock;
  let guard: GuestSigningAccessGuard;

  const contextFor = (token: string | undefined, documentId = 'd-1') => {
    const request: Record<string, unknown> = {
      headers: token ? { [GUEST_SIGNING_TOKEN_HEADER]: token } : {},
      params: { documentId },
    };
    return {
      request,
      context: {
        switchToHttp: () => ({ getRequest: () => request }),
      } as never,
    };
  };

  beforeEach(() => {
    findActive = jest.fn(async () => access);
    guard = new GuestSigningAccessGuard(tokens, { findActive } as never);
  });

  it('el token lleva el id del acceso como jti y ningún dato personal', () => {
    const { accessToken } = tokens.issue(access as never);
    const payload = new JwtService({}).decode(accessToken);

    expect(payload).toEqual(
      expect.objectContaining({
        jti: 'acc-1',
        documentId: 'd-1',
        collaboratorId: 'c-1',
        purpose: PURPOSE,
      }),
    );
    expect(payload).not.toHaveProperty('email');
  });

  it('deja pasar un token vigente con su acceso activo y publica lo que acredita', async () => {
    const { accessToken } = tokens.issue(access as never);
    const { request, context } = contextFor(accessToken);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(findActive).toHaveBeenCalledWith('acc-1');
    expect(request.guestSigningAccess).toEqual({
      accessId: 'acc-1',
      documentId: 'd-1',
      collaboratorId: 'c-1',
      purpose: PURPOSE,
    });
  });

  it('no sirve en otro documento', async () => {
    const { accessToken } = tokens.issue(access as never);

    await expect(
      guard.canActivate(contextFor(accessToken, 'd-2').context),
    ).rejects.toThrow(InvalidGuestSigningAccessException);
    expect(findActive).not.toHaveBeenCalled();
  });

  it('no sirve si el acceso venció, se revocó o se consumió', async () => {
    const { accessToken } = tokens.issue(access as never);
    findActive.mockResolvedValue(null);

    await expect(
      guard.canActivate(contextFor(accessToken).context),
    ).rejects.toThrow(InvalidGuestSigningAccessException);
  });

  it('no sirve si la fila del acceso es de otro colaborador', async () => {
    const { accessToken } = tokens.issue(access as never);
    findActive.mockResolvedValue({ ...access, collaboratorId: 'c-2' });

    await expect(
      guard.canActivate(contextFor(accessToken).context),
    ).rejects.toThrow(InvalidGuestSigningAccessException);
  });

  it('rechaza un token ausente, alterado o firmado con la llave de sesión', async () => {
    await expect(
      guard.canActivate(contextFor(undefined).context),
    ).rejects.toThrow(InvalidGuestSigningAccessException);

    const { accessToken } = tokens.issue(access as never);
    await expect(
      guard.canActivate(contextFor(`${accessToken}x`).context),
    ).rejects.toThrow(InvalidGuestSigningAccessException);

    const sessionToken = new JwtService({
      secret: 'jwt-secret-de-prueba',
    }).sign(
      { purpose: PURPOSE, documentId: 'd-1', collaboratorId: 'c-1' },
      {
        jwtid: 'acc-1',
      },
    );
    await expect(
      guard.canActivate(contextFor(sessionToken).context),
    ).rejects.toThrow(InvalidGuestSigningAccessException);
  });

  it('rechaza un token vencido', async () => {
    const { accessToken } = tokens.issue({
      ...access,
      expiresAt: new Date(Date.now() - 60_000),
    } as never);
    // `issue` nunca firma con vigencia menor a 1 s; se espera a que caduque.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await expect(
      guard.canActivate(contextFor(accessToken).context),
    ).rejects.toThrow(InvalidGuestSigningAccessException);
  });
});

import { ExecutionContext, NotFoundException } from '@nestjs/common';

import {
  PUBLIC_SIGNING_INVITATION_COOKIE,
  PUBLIC_SIGNING_SESSION_COOKIE,
} from '../public-signing-session.cookie';
import { SigningInvitationAccessTokenService } from '../services/signing-invitation-access-token.service';
import { PublicSigningSessionTokenService } from '../services/public-signing-session-token.service';
import {
  InvalidSigningInvitationAccessException,
  SigningInvitationAccessGuard,
} from './signing-invitation-access.guard';

describe('SigningInvitationAccessGuard', () => {
  const config = { get: () => 'jwt-secret-de-prueba' } as never;
  const tokens = new SigningInvitationAccessTokenService(config);
  let resolveById: jest.Mock;
  let guard: SigningInvitationAccessGuard;

  function context(cookie?: string) {
    const request: Record<string, any> = {
      headers: cookie ? { cookie } : {},
    };
    return {
      request,
      ctx: {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
    };
  }

  beforeEach(() => {
    resolveById = jest.fn(async () => ({ invitation: { id: 'inv-1' } }));
    guard = new SigningInvitationAccessGuard(tokens, { resolveById } as never);
  });

  it.each(['EMAIL', 'THIRD_PARTY_PORTAL'] as const)(
    'resuelve la invitación de la cookie y conserva el canal %s',
    async (channel) => {
      const { token } = tokens.issue({ invitationId: 'inv-1', channel });
      const { request, ctx } = context(
        `${PUBLIC_SIGNING_INVITATION_COOKIE}=${token}`,
      );

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(resolveById).toHaveBeenCalledWith('inv-1');
      expect(request.signingInvitationAccess).toEqual({
        resolved: { invitation: { id: 'inv-1' } },
        channel,
      });
    },
  );

  it.each([
    ['sin cookie', () => context()],
    [
      'con la cookie manipulada',
      () => context(`${PUBLIC_SIGNING_INVITATION_COOKIE}=x.y.z`),
    ],
    [
      'con la cookie de una sesión de firma en lugar del acceso',
      () =>
        context(
          `${PUBLIC_SIGNING_INVITATION_COOKIE}=${
            new PublicSigningSessionTokenService(config).issue(
              {
                id: 's-1',
                documentId: 'd-1',
                collaboratorId: 'c-1',
                expiresAt: new Date(Date.now() + 60_000),
              } as never,
              'inv-1',
              'EMAIL',
            ).token
          }`,
        ),
    ],
    [
      'con sólo la cookie de la sesión',
      () =>
        context(
          `${PUBLIC_SIGNING_SESSION_COOKIE}=${tokens.issue({ invitationId: 'inv-1', channel: 'EMAIL' }).token}`,
        ),
    ],
  ])('401 %s', async (_case, build) => {
    await expect(guard.canActivate(build().ctx)).rejects.toBeInstanceOf(
      InvalidSigningInvitationAccessException,
    );
    expect(resolveById).not.toHaveBeenCalled();
  });

  it('401 si la invitación de la cookie ya no existe', async () => {
    resolveById.mockRejectedValue(new NotFoundException());
    const { token } = tokens.issue({ invitationId: 'inv-1', channel: 'EMAIL' });
    await expect(
      guard.canActivate(
        context(`${PUBLIC_SIGNING_INVITATION_COOKIE}=${token}`).ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidSigningInvitationAccessException);
  });
});

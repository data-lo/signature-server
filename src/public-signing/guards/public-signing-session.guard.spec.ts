import { ExecutionContext } from '@nestjs/common';

import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from 'src/document/enum/guest-signing-access-purpose.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';

import { PUBLIC_SIGNING_SESSION_COOKIE } from '../public-signing-session.cookie';
import { PublicSigningSessionTokenService } from '../services/public-signing-session-token.service';
import {
  InvalidPublicSigningSessionException,
  PublicSigningSessionGuard,
} from './public-signing-session.guard';

describe('PublicSigningSessionGuard', () => {
  const tokens = new PublicSigningSessionTokenService({
    get: () => 'jwt-secret-de-prueba',
  } as never);
  let access: Record<string, any> | null;
  let invitation: Record<string, any> | null;
  let accesses: { findActive: jest.Mock };
  let invitations: { findById: jest.Mock };
  let guard: PublicSigningSessionGuard;
  let cookieToken: string;

  function context(headers: Record<string, unknown>) {
    const request: Record<string, any> = { headers };
    return {
      request,
      ctx: {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
    };
  }

  function withCookie(value = cookieToken) {
    return context({
      cookie: `otra=1; ${PUBLIC_SIGNING_SESSION_COOKIE}=${value}`,
    });
  }

  beforeEach(() => {
    access = {
      id: 'acc-session-1',
      documentId: 'd-1',
      collaboratorId: 'c-1',
      purpose: GUEST_SIGNING_ACCESS_PURPOSE_ENUM.PUBLIC_SIGNING_SESSION,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };
    invitation = {
      id: 'inv-1',
      documentId: 'd-1',
      collaboratorId: 'c-1',
      revokedAt: null,
      document: { id: 'd-1', organizationId: 'org-1' },
      collaborator: {
        id: 'c-1',
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
        accountId: 'account-1',
        account: {
          userId: 'user-1',
          user: { lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED },
        },
      },
    };
    accesses = { findActive: jest.fn(async () => access) };
    invitations = { findById: jest.fn(async () => invitation) };
    guard = new PublicSigningSessionGuard(
      tokens,
      accesses as never,
      invitations as never,
    );
    cookieToken = tokens.issue(access as never, 'inv-1').token;
  });

  it('resuelve el actor PUBLIC_INVITATION desde la cookie, sin nada del cliente', async () => {
    const { request, ctx } = withCookie();

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(request.signingSession.actor).toEqual({
      type: 'PUBLIC_INVITATION',
      invitationId: 'inv-1',
      collaboratorId: 'c-1',
      userId: 'user-1',
      accountId: 'account-1',
      organizationId: 'org-1',
      sessionAccessId: 'acc-session-1',
      verifiedEmail: true,
    });
    expect(request.signingSession.document.id).toBe('d-1');
    expect(accesses.findActive).toHaveBeenCalledWith('acc-session-1');
    expect(invitations.findById).toHaveBeenCalledWith('inv-1');
  });

  it('sin usuario provisional (FIEL sin cuenta): actor sin userId ni accountId', async () => {
    invitation!.collaborator = {
      id: 'c-1',
      colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      signatureType: SIGNATURE_TYPE_ENUM.FIEL,
      accountId: null,
      account: null,
    };
    const { request, ctx } = withCookie();

    await guard.canActivate(ctx);

    expect(request.signingSession.actor).not.toHaveProperty('userId');
    expect(request.signingSession.actor).not.toHaveProperty('accountId');
  });

  it.each([
    ['sin cookie', () => context({})],
    [
      'con un JWT de la plataforma en Authorization',
      () => context({ authorization: `Bearer ${cookieToken}` }),
    ],
    ['con la cookie manipulada', () => withCookie(`${cookieToken}x`)],
    [
      'con un token firmado con otra llave',
      () =>
        withCookie(
          new PublicSigningSessionTokenService({
            get: () => 'otro-secreto',
          } as never).issue(access as never, 'inv-1').token,
        ),
    ],
  ])('401 %s', async (_case, build) => {
    await expect(guard.canActivate(build().ctx)).rejects.toBeInstanceOf(
      InvalidPublicSigningSessionException,
    );
  });

  it.each([
    ['el acceso ya no está activo', () => (access = null)],
    [
      'el acceso es de otro propósito',
      () =>
        (access!.purpose =
          GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS),
    ],
    [
      'el acceso es de otro colaborador',
      () => (access!.collaboratorId = 'c-2'),
    ],
    ['la invitación no existe', () => (invitation = null)],
    ['la invitación se revocó', () => (invitation!.revokedAt = new Date())],
    [
      'la invitación es de otro colaborador',
      () => (invitation!.collaboratorId = 'c-2'),
    ],
    [
      'el usuario del firmante ya se activó',
      () =>
        (invitation!.collaborator.account.user.lifecycleStatus =
          USER_LIFECYCLE_STATUS_ENUM.ACTIVE),
    ],
  ])('401 si %s', async (_case, mutate) => {
    mutate();
    await expect(guard.canActivate(withCookie().ctx)).rejects.toBeInstanceOf(
      InvalidPublicSigningSessionException,
    );
  });
});

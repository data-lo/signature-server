import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';

import { SigningInvitationAccessContext } from '../interfaces/signing-invitation-access-context.interface';

/**
 * Contexto de acceso a la invitación que dejó `SigningInvitationAccessGuard`.
 *
 * @returns El `SigningInvitationAccessContext` del request.
 *
 * @throws {InternalServerErrorException} Si se usa en una ruta sin el guard.
 *
 * @example
 * ```ts
 * requestCode(@CurrentInvitationAccess() access: SigningInvitationAccessContext) {}
 * ```
 */
export const CurrentInvitationAccess = createParamDecorator(
  (
    _data: unknown,
    context: ExecutionContext,
  ): SigningInvitationAccessContext => {
    const access = context.switchToHttp().getRequest<{
      signingInvitationAccess?: SigningInvitationAccessContext;
    }>().signingInvitationAccess;
    if (!access) {
      throw new InternalServerErrorException(
        'La ruta no tiene SigningInvitationAccessGuard',
      );
    }
    return access;
  },
);

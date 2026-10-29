import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

/**
 * El acceso temporal de invitado falta, venció, está alterado, se revocó, ya se consumió o no
 * corresponde a este documento o colaborador. Un solo mensaje para todos los casos: al invitado le
 * basta saber que tiene que pedir otro código.
 */
export class InvalidGuestSigningAccessException extends UnauthorizedException {
  constructor() {
    super(
      'Tu acceso a esta firma no es válido o venció. Solicita un nuevo código de verificación.',
    );
  }
}

/**
 * La invitación no admite Firma Avanzada sin cuenta: el colaborador no es del documento, el correo
 * no coincide, no es firmante FIEL o ya tiene una cuenta vinculada. Mismo mensaje en todos los
 * casos para no confirmar cuál de los datos falla.
 */
export class GuestAdvancedInvitationNotFoundException extends ForbiddenException {
  constructor() {
    super('Esta invitación no permite firmar con Firma Avanzada sin cuenta.');
  }
}

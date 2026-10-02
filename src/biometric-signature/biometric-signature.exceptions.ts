import {
  ForbiddenException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

/**
 * El firmante con cuenta no tiene una identidad Didit aprobada contra la cual comparar su rostro.
 * Se resuelve completando la verificación de identidad, no reintentando la firma.
 */
export class BiometricIdentityNotVerifiedException extends ForbiddenException {
  constructor() {
    super(
      'Para firmar con biometría necesitas tener tu identidad verificada. Verifícala en "Identidad y firma" y vuelve a intentarlo.',
    );
  }
}

/**
 * La identidad está aprobada, pero Didit ya no entrega una imagen de su rostro (la sesión de
 * identidad no tiene prueba de vida ni retrato utilizables, o pesan más de lo que admite el face
 * match). Sin referencia no hay contra qué comparar.
 */
export class BiometricReferencePortraitUnavailableException extends UnprocessableEntityException {
  constructor(detail: string) {
    super(
      `No fue posible obtener la imagen de referencia de tu identidad (${detail}). Vuelve a verificar tu identidad e inténtalo de nuevo.`,
    );
  }
}

/** El token de acceso de invitado falta, venció, está alterado o no corresponde a esta firma. */
export class InvalidGuestAccessTokenException extends UnauthorizedException {
  constructor() {
    super(
      'Tu acceso a esta firma no es válido o venció. Solicita un nuevo código de verificación.',
    );
  }
}

/**
 * La invitación no admite firma biométrica sin cuenta: el colaborador no existe en el documento,
 * el correo no coincide, ya tiene cuenta vinculada o su firma no es biométrica. Se responde con el
 * mismo mensaje en todos los casos para no confirmar cuál de los datos es el que falla.
 */
export class GuestInvitationNotFoundException extends ForbiddenException {
  constructor() {
    super('Esta invitación no permite firmar con biometría sin cuenta.');
  }
}

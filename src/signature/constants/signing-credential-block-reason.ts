import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';

/**
 * Por qué el usuario todavía no puede tocar su firma manuscrita, según su estado global.
 *
 * Se explica el motivo en vez de devolver un 403 seco: un "no puedes subir tu firma" sin decir
 * que la verificación sigue en revisión deja al usuario sin saber qué hacer a continuación.
 *
 * Vive fuera de los casos de uso porque son dos los que aplican la misma regla —subir el PNG
 * directamente (`UploadSignatureImageUseCase`) y abrir una sesión de captura por canvas o QR
 * (`CreateSignatureCaptureSessionUseCase`)—: con una copia en cada uno, el día que cambie el
 * texto o se agregue un estado, uno de los dos se quedaría atrás y el usuario recibiría
 * explicaciones distintas según por dónde entrara.
 *
 * SIGNATURE_PENDING no tiene motivo porque es justamente el estado que habilita la operación.
 */
export const SIGNING_CREDENTIAL_BLOCK_REASON: Record<
  SIGNING_CREDENTIAL_STATUS_ENUM,
  string
> = {
  [SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_REQUIRED]:
    'Necesitas validar tu identidad antes de registrar tu firma.',
  [SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_PENDING]:
    'Tu verificación de identidad aún no ha comenzado. Complétala antes de registrar tu firma.',
  [SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_IN_PROGRESS]:
    'Tu verificación de identidad está en curso. Termínala antes de registrar tu firma.',
  [SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_IN_REVIEW]:
    'Tu identidad está en revisión. Te avisaremos en cuanto tengamos el resultado.',
  [SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_RETRY_REQUIRED]:
    'No fue posible validar tu identidad. Inicia una nueva verificación para registrar tu firma.',
  [SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_FAILED]:
    'Tu verificación de identidad está bloqueada. Contacta a soporte para continuar.',
  [SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED]:
    'Agotaste tus intentos de verificación de identidad. Contacta a soporte para desbloquear tu cuenta.',
  [SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING]: '',
  [SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED]:
    'Ya tienes una firma registrada. Elimínala antes de subir una nueva.',
};

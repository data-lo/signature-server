import { IDENTITY_CHECK_OUTCOME_ENUM } from '../enums/identity-check-outcome.enum';

/**
 * Resumen del veredicto del proveedor: qué se comprobó y cómo salió cada cosa.
 *
 * Es lo que alimenta "Ver detalle de la validación" en la pantalla "Identidad y firma".
 *
 * **Deliberadamente NO lleva datos personales.** El veredicto crudo de Didit trae nombre,
 * fecha de nacimiento, número de documento, domicilio, los recortes de la INE y las
 * puntuaciones de cada modelo. Todo eso se conserva en `identity_verifications.decision` para
 * auditoría, pero al navegador sólo salen estos tres resultados: es lo único que el usuario
 * necesita para entender por qué su identidad se aprobó o se rechazó, y cada campo extra sería
 * un dato personal más viajando por la red, guardado en el cache del navegador y visible en una
 * captura de pantalla.
 *
 * Un campo en `null` significa que el proveedor no reportó esa comprobación (workflow que no la
 * incluye, o intento que no llegó tan lejos), no que haya fallado.
 */
export interface IdentityVerificationChecks {
  /** Lectura y validación del documento oficial (INE). */
  documentReading: IDENTITY_CHECK_OUTCOME_ENUM | null;
  /** La selfie corresponde a la foto del documento. */
  faceMatch: IDENTITY_CHECK_OUTCOME_ENUM | null;
  /** La selfie proviene de una persona presente, no de una foto o un video. */
  liveness: IDENTITY_CHECK_OUTCOME_ENUM | null;
}

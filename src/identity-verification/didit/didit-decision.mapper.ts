import { IDENTITY_CHECK_OUTCOME_ENUM } from '../enums/identity-check-outcome.enum';
import { IdentityVerificationChecks } from '../interfaces/identity-checks.interface';

/**
 * Vocabulario de Didit para el resultado de cada comprobación, normalizado.
 *
 * Las claves están en minúsculas y sin separadores porque el proveedor no es consistente entre
 * endpoints (`no_match`, `No Match`, `NOT_LIVE`). Un valor que no esté en esta tabla se resuelve
 * como `null` —"no reportado"— y nunca como aprobado: inventar una aprobación a partir de un
 * valor que no entendemos es exactamente el error que no se puede cometer acá.
 */
const OUTCOME_BY_PROVIDER_VALUE: Record<string, IDENTITY_CHECK_OUTCOME_ENUM> = {
  approved: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
  match: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
  live: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
  success: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
  passed: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
  declined: IDENTITY_CHECK_OUTCOME_ENUM.FAILED,
  rejected: IDENTITY_CHECK_OUTCOME_ENUM.FAILED,
  nomatch: IDENTITY_CHECK_OUTCOME_ENUM.FAILED,
  notlive: IDENTITY_CHECK_OUTCOME_ENUM.FAILED,
  failed: IDENTITY_CHECK_OUTCOME_ENUM.FAILED,
  fail: IDENTITY_CHECK_OUTCOME_ENUM.FAILED,
  inreview: IDENTITY_CHECK_OUTCOME_ENUM.IN_REVIEW,
  review: IDENTITY_CHECK_OUTCOME_ENUM.IN_REVIEW,
  warning: IDENTITY_CHECK_OUTCOME_ENUM.IN_REVIEW,
};

/**
 * Nombres con los que Didit ha publicado cada bloque del veredicto. Se prueban en orden y gana
 * el primero que exista: así un renombre del proveedor no rompe la pantalla mientras alguno de
 * los alias siga vivo.
 */
const DECISION_SECTIONS = {
  documentReading: ['id_verification', 'document_verification', 'id_document'],
  faceMatch: ['face_match', 'facematch', 'face_verification'],
  liveness: ['liveness', 'liveness_detection'],
} as const;

/**
 * Reduce el veredicto crudo de Didit al resumen que ve el usuario.
 *
 * Función pura y sin dependencias: se puede probar contra cuerpos reales del proveedor sin
 * levantar nada. Vive junto al adaptador HTTP porque, igual que él, su única razón de cambio es
 * que Didit cambie su contrato.
 *
 * **Es la frontera de datos personales del módulo.** Sólo puede devolver valores del enum de
 * resultados: no copia ni deriva ningún campo del veredicto, así que aunque Didit agregue mañana
 * el CURP o una foto al payload, eso no puede llegar al navegador por esta vía.
 *
 * @returns `null` si no se pudo leer ninguna comprobación, para que la pantalla muestre "no
 *   disponible" en lugar de tres renglones vacíos que parecen un error.
 */
export function summarizeDiditDecision(
  decision: Record<string, unknown> | null | undefined,
): IdentityVerificationChecks | null {
  if (!isObject(decision)) {
    return null;
  }

  const checks: IdentityVerificationChecks = {
    documentReading: readSection(decision, DECISION_SECTIONS.documentReading),
    faceMatch: readSection(decision, DECISION_SECTIONS.faceMatch),
    liveness: readSection(decision, DECISION_SECTIONS.liveness),
  };

  const reportedSomething = Object.values(checks).some(
    (outcome) => outcome !== null,
  );

  return reportedSomething ? checks : null;
}

/**
 * Cada bloque puede venir como objeto (`{ status: 'match', score: 97 }`) o directamente como
 * cadena (`face_match: 'match'`). Se aceptan ambas formas y se ignora todo lo demás del bloque
 * —las puntuaciones incluidas—, que no se expone.
 */
function readSection(
  decision: Record<string, unknown>,
  aliases: readonly string[],
): IDENTITY_CHECK_OUTCOME_ENUM | null {
  for (const alias of aliases) {
    const section = decision[alias];

    if (typeof section === 'string') {
      const outcome = toOutcome(section);
      if (outcome) return outcome;
      continue;
    }

    if (isObject(section)) {
      const outcome = toOutcome(section.status) ?? toOutcome(section.result);
      if (outcome) return outcome;
    }
  }

  return null;
}

function toOutcome(value: unknown): IDENTITY_CHECK_OUTCOME_ENUM | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.toLowerCase().replace(/[\s_-]/g, '');

  return OUTCOME_BY_PROVIDER_VALUE[normalized] ?? null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

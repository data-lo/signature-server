import type {
  BiometricCheckEvidence,
  BiometricDecisionEvidence,
} from '../interfaces/biometric-decision-evidence.interface';

/**
 * Alias de cada bloque del veredicto: el plural es la forma V3 (arreglo) y el singular la V2
 * (objeto). Mismo criterio que `summarizeDiditDecision`.
 */
const SECTIONS = {
  liveness: ['liveness_checks', 'liveness'],
  faceMatch: ['face_matches', 'face_match'],
  idVerification: ['id_verifications', 'id_verification'],
} as const;

/**
 * Reduce el veredicto de Didit a la evidencia mínima que se guarda (ver
 * `BiometricDecisionEvidence`).
 *
 * Función pura y frontera de datos personales: sólo copia `status`, `score` y `method` de cada
 * prueba. Aunque Didit agregue mañana una selfie o el CURP al veredicto, no puede llegar a la base
 * por esta vía.
 *
 * @param sessionStatus - `status` de la entrega (estado global de la sesión).
 * @param decision - `decision` del webhook, o `null` si no vino.
 * @returns La evidencia mínima; listas vacías para los bloques que no vinieron.
 *
 * @example
 * ```ts
 * toBiometricDecisionEvidence('Approved', {
 *   liveness_checks: [{ status: 'Approved', score: 98, method: 'ACTIVE_3D', reference_image: 'https://…' }],
 * });
 * // → { sessionStatus: 'Approved', livenessChecks: [{ status: 'Approved', score: 98, method: 'ACTIVE_3D' }], … }
 * ```
 */
export function toBiometricDecisionEvidence(
  sessionStatus: string | null,
  decision: Record<string, unknown> | null,
): BiometricDecisionEvidence {
  return {
    sessionStatus,
    livenessChecks: readChecks(decision, SECTIONS.liveness),
    faceMatches: readChecks(decision, SECTIONS.faceMatch),
    idVerifications: readChecks(decision, SECTIONS.idVerification),
  };
}

/**
 * Comprueba que el veredicto traiga APROBADAS las pruebas que exige el tipo de firmante.
 *
 * El estado global `Approved` de la sesión no basta: si el workflow quedara mal configurado en
 * Didit (por ejemplo, sin face match), la sesión se aprobaría con sólo la prueba de vida y se
 * firmaría sin comparar el rostro con nadie. Cada bloque exigido tiene que existir y tener TODAS
 * sus entradas en `Approved`.
 *
 * @param evidence - Evidencia ya reducida.
 * @param requireIdVerification - `true` para invitados (KYC: identificación obligatoria).
 * @returns El nombre de la primera prueba faltante o no aprobada, o `null` si todo está aprobado.
 *
 * @example
 * ```ts
 * findMissingApproval(evidence, false); // null | 'face match'
 * ```
 */
export function findMissingApproval(
  evidence: BiometricDecisionEvidence,
  requireIdVerification: boolean,
): string | null {
  const required: [string, BiometricCheckEvidence[]][] = [
    ['prueba de vida', evidence.livenessChecks],
    ['face match', evidence.faceMatches],
  ];
  if (requireIdVerification) {
    required.push(['verificación de identificación', evidence.idVerifications]);
  }

  for (const [name, checks] of required) {
    const allApproved =
      checks.length > 0 &&
      checks.every((check) => normalize(check.status) === 'approved');
    if (!allApproved) {
      return name;
    }
  }

  return null;
}

/**
 * Lee un bloque del veredicto por cualquiera de sus alias y lo reduce a evidencia.
 *
 * @param decision - Veredicto crudo, o `null`.
 * @param aliases - Nombres posibles del bloque (V3 y V2).
 * @returns Las pruebas reducidas; vacío si el bloque no vino.
 *
 * @example
 * ```ts
 * readChecks({ face_match: { status: 'Approved' } }, ['face_matches', 'face_match']);
 * ```
 */
function readChecks(
  decision: Record<string, unknown> | null,
  aliases: readonly string[],
): BiometricCheckEvidence[] {
  if (!isObject(decision)) {
    return [];
  }

  for (const alias of aliases) {
    const section = decision[alias];
    if (Array.isArray(section)) {
      return section.filter(isObject).map(toCheck);
    }
    if (isObject(section)) {
      return [toCheck(section)];
    }
  }

  return [];
}

/**
 * Copia de una prueba sólo `status`, `score` y `method`.
 *
 * @param entry - Entrada del veredicto.
 * @returns La prueba reducida.
 *
 * @example
 * ```ts
 * toCheck({ status: 'Approved', score: 90, reference_image: 'https://…' }); // sin la URL
 * ```
 */
function toCheck(entry: Record<string, unknown>): BiometricCheckEvidence {
  return {
    status: typeof entry.status === 'string' ? entry.status : null,
    score:
      typeof entry.score === 'number' && Number.isFinite(entry.score)
        ? entry.score
        : null,
    method: typeof entry.method === 'string' ? entry.method : null,
  };
}

/**
 * Normaliza un estado de Didit para compararlo (`In Review` y `in_review` son el mismo).
 *
 * @param value - Estado, o `null`.
 * @returns En minúsculas y sin espacios, guiones ni guiones bajos.
 *
 * @example
 * ```ts
 * normalize('In Review'); // 'inreview'
 * ```
 */
function normalize(value: string | null): string {
  return (value ?? '').toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Indica si el valor es un objeto plano.
 *
 * @param value - Valor a evaluar.
 * @returns `true` si es objeto y no arreglo ni `null`.
 *
 * @example
 * ```ts
 * isObject([]); // false
 * ```
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

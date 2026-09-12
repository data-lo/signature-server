/**
 * Bloques del veredicto de Didit que describen el documento de identidad, en orden de preferencia:
 * `id_verifications` es la forma V3 (un arreglo, porque un workflow puede leer varios documentos) y
 * `id_verification` la V2 (un objeto). Mismo criterio de alias que `summarizeDiditDecision`.
 */
const DOCUMENT_SECTIONS = ['id_verifications', 'id_verification'] as const;

/** Campos de cada lectura de documento con la URL de su imagen frontal y trasera. */
const FRONT_IMAGE_FIELD = 'front_image';
const BACK_IMAGE_FIELD = 'back_image';

/** URLs de las imágenes de la INE que trae un veredicto; `null` la que no venga. */
export interface IdentityDocumentImageUrls {
  front: string | null;
  back: string | null;
}

/**
 * Extrae del veredicto de Didit las URLs de las imágenes frontal y trasera de la INE.
 *
 * Función pura, junto al mapper del veredicto: su única razón de cambio es que Didit cambie su
 * contrato. **Nunca registra ni devuelve nada más del veredicto**, que está lleno de datos del
 * titular.
 *
 * Prefiere la primera lectura de documento que traiga AMBAS imágenes. Si ninguna las trae
 * completas, devuelve lo que haya en la primera que tenga alguna, para que quien llama pueda decir
 * cuál falta.
 *
 * @param decision - `decision` del webhook de Didit, o `null`.
 * @returns Las URLs encontradas; `{ front: null, back: null }` si el veredicto no las incluye.
 *
 * @example
 * ```ts
 * extractIdentityDocumentImageUrls({
 *   id_verifications: [{ front_image: 'https://…/front.jpg', back_image: 'https://…/back.jpg' }],
 * }); // { front: 'https://…/front.jpg', back: 'https://…/back.jpg' }
 * ```
 */
export function extractIdentityDocumentImageUrls(
  decision: Record<string, unknown> | null | undefined,
): IdentityDocumentImageUrls {
  let partial: IdentityDocumentImageUrls | null = null;

  if (!isObject(decision)) {
    return { front: null, back: null };
  }

  for (const section of DOCUMENT_SECTIONS) {
    for (const entry of toEntries(decision[section])) {
      const front = asNonEmptyString(entry[FRONT_IMAGE_FIELD]);
      const back = asNonEmptyString(entry[BACK_IMAGE_FIELD]);

      if (front && back) {
        return { front, back };
      }

      if (!partial && (front || back)) {
        partial = { front, back };
      }
    }
  }

  return partial ?? { front: null, back: null };
}

/**
 * Normaliza un bloque del veredicto a una lista de lecturas: V3 trae un arreglo, V2 un objeto.
 *
 * @param section - Valor del bloque en el veredicto.
 * @returns Las lecturas que son objetos; vacío si el bloque no existe o no tiene esa forma.
 *
 * @example
 * ```ts
 * toEntries({ front_image: 'x' }); // [{ front_image: 'x' }]
 * ```
 */
function toEntries(section: unknown): Record<string, unknown>[] {
  if (Array.isArray(section)) {
    return section.filter(isObject);
  }

  return isObject(section) ? [section] : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

import { BadRequestException } from '@nestjs/common';

import { SignaturePositionDto } from '../dto/create-document-signatures.dto';

/**
 * Tolerancia para `ratio + tamaño ≤ 1`. El frontend acomoda la caja con `1 - widthRatio` (ver
 * `clampBoxPosition` en signature-app), y en coma flotante la suma de vuelta puede dar
 * `1.0000000000000002`: sin margen se rechazaría una firma pegada al borde que es perfectamente
 * válida.
 */
const RATIO_EPSILON = 1e-9;

/**
 * Comprueba que cada posición de firma caiga dentro del documento: en una página que exista y
 * con la caja completa dentro de ella.
 *
 * El DTO ya valida cada campo por separado (ratios entre 0 y 1, tamaño mayor que 0, página ≥ 1),
 * pero no puede validar lo que depende de dos campos a la vez ni del PDF: una caja con
 * `xRatio: 0.9` y `widthRatio: 0.2` pasa campo por campo y se sale de la página, y una
 * `page: 7` en un PDF de 3 páginas es válida hasta que se intenta estampar. Las dos se detectarían
 * recién al firmar, con el documento ya enviado.
 *
 * @param positions - Todas las posiciones del payload, de todos los firmantes.
 * @param totalPages - Páginas del PDF recibido.
 * @returns Nada: validar es no lanzar.
 *
 * @throws {BadRequestException} (400) Si alguna posición está en una página que el documento no
 *   tiene, o si su caja se sale de la página.
 *
 * @example
 * ```ts
 * assertSignaturePositionsInsideDocument(allPositions, 3);
 * ```
 */
export function assertSignaturePositionsInsideDocument(
  positions: SignaturePositionDto[],
  totalPages: number,
): void {
  const violation = findSignaturePositionOutsideDocument(positions, totalPages);
  if (!violation) return;

  const { position } = violation;
  throw new BadRequestException(
    violation.reason === 'PAGE_OUT_OF_RANGE'
      ? `La ubicación de firma está en la página ${position.page}, pero el documento sólo tiene ${totalPages}`
      : `La ubicación de firma en la página ${position.page} se sale de los límites de la página`,
  );
}

/** Por qué una posición no cabe en el documento. */
export type SignaturePositionOutsideReason =
  | 'PAGE_OUT_OF_RANGE'
  | 'OUT_OF_PAGE_BOUNDS';

/** La primera posición que no cabe en el documento, con su índice en el arreglo recibido. */
export interface SignaturePositionOutsideDocument {
  index: number;
  position: SignaturePositionDto;
  reason: SignaturePositionOutsideReason;
}

/**
 * La regla de `assertSignaturePositionsInsideDocument`, sin lanzar: devuelve la primera posición
 * que está en una página que el documento no tiene, o cuya caja se sale de la página.
 *
 * Existe para quien necesita decir QUÉ posición falla —la API de integración responde con el campo
 * exacto—; el flujo de la plataforma sigue usando el `assert`, con los mismos mensajes de siempre.
 *
 * @param positions - Posiciones a revisar, en el orden en que se quieren reportar.
 * @param totalPages - Páginas del PDF recibido.
 * @returns La primera violación, o `null` si todas caben.
 *
 * @example
 * ```ts
 * findSignaturePositionOutsideDocument([{ page: 7, … }], 3);
 * // { index: 0, position: { page: 7, … }, reason: 'PAGE_OUT_OF_RANGE' }
 * ```
 */
export function findSignaturePositionOutsideDocument(
  positions: SignaturePositionDto[],
  totalPages: number,
): SignaturePositionOutsideDocument | null {
  for (const [index, position] of positions.entries()) {
    if (position.page > totalPages) {
      return { index, position, reason: 'PAGE_OUT_OF_RANGE' };
    }

    const exceedsWidth =
      position.xRatio + position.widthRatio > 1 + RATIO_EPSILON;
    const exceedsHeight =
      position.yRatio + position.heightRatio > 1 + RATIO_EPSILON;

    if (exceedsWidth || exceedsHeight) {
      return { index, position, reason: 'OUT_OF_PAGE_BOUNDS' };
    }
  }

  return null;
}

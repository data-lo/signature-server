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
  for (const position of positions) {
    if (position.page > totalPages) {
      throw new BadRequestException(
        `La ubicación de firma está en la página ${position.page}, pero el documento sólo tiene ${totalPages}`,
      );
    }

    const exceedsWidth =
      position.xRatio + position.widthRatio > 1 + RATIO_EPSILON;
    const exceedsHeight =
      position.yRatio + position.heightRatio > 1 + RATIO_EPSILON;

    if (exceedsWidth || exceedsHeight) {
      throw new BadRequestException(
        `La ubicación de firma en la página ${position.page} se sale de los límites de la página`,
      );
    }
  }
}

import { BadRequestException } from '@nestjs/common';
import { SignaturePositionDto } from '../dto/create-document-signatures.dto';

/**
 * Comprueba si dos AABB (axis-aligned bounding box) en ratios 0-1 se solapan. Es el mismo algoritmo
 * que `boxesOverlap` en el frontend, duplicado a propósito: son dos repos y lenguajes distintos sin
 * un paquete compartido, y cuatro comparaciones no justifican la complejidad de sincronizarlas.
 *
 * Los bordes que sólo se tocan NO cuentan como colisión.
 */
function boxesOverlap(
  a: SignaturePositionDto,
  b: SignaturePositionDto,
): boolean {
  return (
    a.xRatio < b.xRatio + b.widthRatio &&
    a.xRatio + a.widthRatio > b.xRatio &&
    a.yRatio < b.yRatio + b.heightRatio &&
    a.yRatio + a.heightRatio > b.yRatio
  );
}

/**
 * Rechaza posiciones de firma que se solapen, como defensa en profundidad: la UI ya lo impide, pero
 * un cliente distinto —o un bug futuro del frontend— no debe poder colar posiciones inconsistentes.
 *
 * Revisa TODAS las posiciones de TODOS los firmantes del payload agrupadas por página: el
 * solapamiento importa sin importar si son del mismo firmante o de dos distintos.
 */
export function assertNoOverlappingSignaturePositions(
  positionsByPage: Map<number, SignaturePositionDto[]>,
): void {
  for (const positions of positionsByPage.values()) {
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) {
        if (boxesOverlap(positions[i], positions[j])) {
          throw new BadRequestException(
            'Las firmas de los colaboradores no pueden solaparse en la misma página',
          );
        }
      }
    }
  }
}

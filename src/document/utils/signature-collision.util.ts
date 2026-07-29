import { BadRequestException } from '@nestjs/common';
import { SignaturePositionDto } from '../dto/create-document-signatures.dto';

/**
 * AABB (axis-aligned bounding box) en ratios 0-1 — mismo algoritmo que
 * `boxesOverlap` en el frontend (`lib/signature-geometry.ts`), duplicado a propósito: son dos
 * repos/lenguajes distintos sin un paquete compartido, y es una función lo bastante pequeña
 * (4 comparaciones) para no justificar la complejidad de sincronizarla entre ambos.
 * Bordes que solo se tocan (`a.xRatio + a.widthRatio === b.xRatio`) NO cuentan como colisión.
 */
function boxesOverlap(a: SignaturePositionDto, b: SignaturePositionDto): boolean {
  return (
    a.xRatio < b.xRatio + b.widthRatio &&
    a.xRatio + a.widthRatio > b.xRatio &&
    a.yRatio < b.yRatio + b.heightRatio &&
    a.yRatio + a.heightRatio > b.yRatio
  );
}

/**
 * Defensa en profundidad (ver historia "Ubicación de firmas por usuario"): la UI ya impide
 * colocar firmas que se solapen, pero un cliente distinto (o un bug futuro del frontend) no debe
 * poder colar posiciones inconsistentes. Revisa TODAS las posiciones de TODOS los firmantes del
 * payload agrupadas por página — el solapamiento importa sin importar si son del mismo firmante
 * o de dos distintos.
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

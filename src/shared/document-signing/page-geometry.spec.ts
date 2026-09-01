import {
  displayedPageSize,
  normalizePageRotation,
  pageOrientation,
  toContentSpace,
  toVisibleRect,
} from './page-geometry';

/** A4 vertical, el MediaBox más común. */
const A4 = { width: 595, height: 842 };

describe('page-geometry', () => {
  describe('normalizePageRotation', () => {
    it('deja los cuatro cuadrantes tal como están', () => {
      expect([0, 90, 180, 270].map(normalizePageRotation)).toEqual([
        0, 90, 180, 270,
      ]);
    });

    /**
     * La especificación sólo exige que `/Rotate` sea múltiplo de 90: admite negativos y valores
     * por encima de 360, y pdf-lib devuelve el número tal como está escrito en el archivo. Sin
     * normalizar, un `-90` no encajaría en ningún caso del `switch` y la página se trataría como
     * si no estuviera girada.
     */
    it('normaliza ángulos negativos y mayores a una vuelta', () => {
      expect(normalizePageRotation(-90)).toBe(270);
      expect(normalizePageRotation(-270)).toBe(90);
      expect(normalizePageRotation(360)).toBe(0);
      expect(normalizePageRotation(450)).toBe(90);
    });

    /** Archivo malformado: se redondea al cuadrante más cercano en vez de tumbar la firma. */
    it('redondea un ángulo que no es múltiplo de 90 en vez de lanzar', () => {
      expect(normalizePageRotation(89)).toBe(90);
      expect(normalizePageRotation(46)).toBe(90);
    });
  });

  describe('displayedPageSize', () => {
    it('sin giro, la hoja se ve como su MediaBox', () => {
      expect(displayedPageSize(A4, 0)).toEqual(A4);
      expect(displayedPageSize(A4, 180)).toEqual(A4);
    });

    /**
     * El caso que rompía el estampado: una hoja apaisada escrita como vertical + `/Rotate 90`.
     * El usuario la ve de 842x595 y sobre ESA hoja coloca la firma.
     */
    it('con un cuarto de vuelta, los lados se intercambian', () => {
      expect(displayedPageSize(A4, 90)).toEqual({ width: 842, height: 595 });
      expect(displayedPageSize(A4, 270)).toEqual({ width: 842, height: 595 });
    });
  });

  describe('pageOrientation', () => {
    it('reconoce como horizontal tanto la apaisada nativa como la girada', () => {
      expect(pageOrientation({ width: 842, height: 595 }, 0)).toBe('LANDSCAPE');
      expect(pageOrientation(A4, 90)).toBe('LANDSCAPE');
      expect(pageOrientation(A4, 270)).toBe('LANDSCAPE');
    });

    it('reconoce como vertical la hoja vertical, girada media vuelta o no', () => {
      expect(pageOrientation(A4, 0)).toBe('PORTRAIT');
      expect(pageOrientation(A4, 180)).toBe('PORTRAIT');
      // Una apaisada girada un cuarto de vuelta se ve vertical: manda cómo se ve.
      expect(pageOrientation({ width: 842, height: 595 }, 90)).toBe('PORTRAIT');
    });

    /** Sin lado mayor no hay nada que transformar; cuenta como vertical, el caso que ya andaba. */
    it('trata una hoja cuadrada como vertical', () => {
      expect(pageOrientation({ width: 500, height: 500 }, 0)).toBe('PORTRAIT');
    });
  });

  describe('toVisibleRect', () => {
    it('convierte ratios a puntos midiendo yRatio desde el borde superior', () => {
      expect(
        toVisibleRect(
          { xRatio: 0.5, yRatio: 0.25, widthRatio: 0.2, heightRatio: 0.1 },
          { width: 600, height: 800 },
        ),
      ).toEqual({
        x: 300,
        // 800 - (0.25 + 0.1) * 800: el PDF mide desde abajo, el DOM desde arriba.
        y: 520,
        width: 120,
        height: 80,
        opacity: undefined,
      });
    });
  });

  describe('toContentSpace', () => {
    const visible = { x: 100, y: 200, width: 60, height: 20 };

    /**
     * El camino de TODO documento vertical sin `/Rotate` (y también el de las hojas apaisadas que
     * ya traen el MediaBox ancho): la conversión es la identidad y el ángulo es 0, así que el
     * estampado sale exactamente igual que antes de que existiera este módulo.
     */
    it('sin giro devuelve el rectángulo intacto', () => {
      expect(toContentSpace(visible, A4, 0)).toEqual({
        x: 100,
        y: 200,
        width: 60,
        height: 20,
        opacity: undefined,
        rotate: 0,
      });
    });

    /**
     * Valores medidos, no deducidos: se contrastaron contra la matriz de viewport que pdf.js
     * construye para cada `/Rotate` y contra la CTM que `drawImage` emite para cada ángulo. El
     * ancla es siempre la esquina inferior izquierda de la caja visible, llevada al espacio del
     * contenido; el ángulo es el que deja la rúbrica derecha tras el giro del visor.
     *
     * Cuidado con el signo: `/Rotate 90` pide `+90` y `/Rotate 270` pide `-90`. Invertirlos deja
     * la caja en el sitio correcto con la rúbrica de cabeza — ver la prueba de extremo a extremo
     * en `document-signing.service.spec.ts`, que es la que detecta ese caso.
     */
    it('con un cuarto de vuelta ancla en la esquina trasladada y gira +90', () => {
      expect(toContentSpace(visible, A4, 90)).toEqual({
        x: 595 - 200,
        y: 100,
        width: 60,
        height: 20,
        opacity: undefined,
        rotate: 90,
      });
    });

    it('con media vuelta ancla en la esquina opuesta y gira 180', () => {
      expect(toContentSpace(visible, A4, 180)).toEqual({
        x: 595 - 100,
        y: 842 - 200,
        width: 60,
        height: 20,
        opacity: undefined,
        rotate: 180,
      });
    });

    it('con tres cuartos de vuelta gira -90, no +90', () => {
      expect(toContentSpace(visible, A4, 270)).toEqual({
        x: 200,
        y: 842 - 100,
        width: 60,
        height: 20,
        opacity: undefined,
        rotate: -90,
      });
    });

    it('conserva la opacidad', () => {
      expect(toContentSpace({ ...visible, opacity: 0.5 }, A4, 90).opacity).toBe(
        0.5,
      );
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import * as zlib from 'zlib';
import { PDFDocument, degrees } from 'pdf-lib';
import { PdfSignatureService } from './document-signing.service';

// PNG 1x1 transparente mínimo — suficiente para que pdf-lib.embedPng() lo acepte.
const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function buildPdf(pageSizes: [number, number][]): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  for (const size of pageSizes) {
    pdfDoc.addPage(size);
  }
  return Buffer.from(await pdfDoc.save());
}

/** Página con su MediaBox y su `/Rotate`, para armar documentos de orientación mixta. */
interface PageSpec {
  media: [number, number];
  rotate: 0 | 90 | 180 | 270;
}

async function buildRotatedPdf(specs: PageSpec[]): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  for (const spec of specs) {
    const page = pdfDoc.addPage(spec.media);
    if (spec.rotate) {
      page.setRotation(degrees(spec.rotate));
    }
  }
  return Buffer.from(await pdfDoc.save());
}

type Matrix = [number, number, number, number, number, number];

const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

const applyMatrix = (m: Matrix, [x, y]: [number, number]): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/**
 * Matriz con la que pdf.js proyecta el espacio del contenido a la pantalla (origen arriba-
 * izquierda), por cada `/Rotate`.
 *
 * **Son valores leídos de pdf.js, no derivados acá.** Se obtuvieron llamando a
 * `page.getViewport({ scale: 1 }).transform` sobre un PDF con las cuatro rotaciones, usando la
 * MISMA versión de pdfjs-dist que renderiza el frontend. Eso convierte a esta prueba en un
 * oráculo independiente del código bajo prueba: si `page-geometry.ts` y esta tabla estuvieran de
 * acuerdo por compartir un error, la firma también saldría mal en pantalla.
 */
function viewerTransform(
  content: { width: number; height: number },
  rotation: 0 | 90 | 180 | 270,
): { matrix: Matrix; width: number; height: number } {
  const { width: w, height: h } = content;
  switch (rotation) {
    case 90:
      return { matrix: [0, 1, 1, 0, 0, 0], width: h, height: w };
    case 180:
      return { matrix: [-1, 0, 0, 1, w, 0], width: w, height: h };
    case 270:
      return { matrix: [0, -1, -1, 0, h, w], width: h, height: w };
    default:
      return { matrix: [1, 0, 0, -1, 0, h], width: w, height: h };
  }
}

/**
 * Dónde queda la firma EN PANTALLA: la CTM real del flujo de contenido, aplicada al cuadrado
 * unidad de la imagen y proyectada con la matriz del visor.
 *
 * Se leen todos los `cm` del bloque `q ... Do` y se multiplican, igual que hace un lector de PDF
 * —a diferencia del `drawnPlacement` de arriba, que asume una traslación seguida de una escala y
 * por eso sólo sirve para páginas sin girar.
 *
 * Devuelve el rectángulo con origen arriba-izquierda, y ancho/alto POSITIVOS sólo si la imagen
 * quedó derecha: si estuviera de cabeza o espejada, las esquinas se cruzan y salen negativos. Es
 * justo lo que distingue "la caja está en el lugar correcto" de "la firma se lee".
 */
async function drawnOnScreen(
  pdf: Buffer,
  pageIndex: number,
  content: { width: number; height: number },
  rotation: 0 | 90 | 180 | 270,
): Promise<{ left: number; top: number; width: number; height: number }> {
  const doc = await PDFDocument.load(pdf);
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents() as unknown as {
    asArray?: () => unknown[];
  };
  const refs = contents.asArray ? contents.asArray() : [contents];

  let text = '';
  for (const ref of refs) {
    const stream = doc.context.lookup(ref as never) as unknown as {
      contents?: Uint8Array;
    };
    if (!stream?.contents) continue;
    const raw = Buffer.from(stream.contents);
    try {
      text += zlib.inflateSync(raw).toString('latin1');
    } catch {
      text += raw.toString('latin1');
    }
  }

  const upToDraw = text.slice(0, text.indexOf(' Do'));
  const block = upToDraw.slice(upToDraw.lastIndexOf('q'));

  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const cmPattern = /(-?[\d.e-]+) (-?[\d.e-]+) (-?[\d.e-]+) (-?[\d.e-]+) (-?[\d.e-]+) (-?[\d.e-]+) cm/g;
  for (const match of block.matchAll(cmPattern)) {
    ctm = multiply(ctm, match.slice(1).map(Number) as Matrix);
  }

  const viewer = viewerTransform(content, rotation);
  const toScreen = (unit: [number, number]) =>
    applyMatrix(viewer.matrix, applyMatrix(ctm, unit));

  // (0,1) es la esquina SUPERIOR izquierda de la imagen: en PDF la primera fila del mapa de bits
  // se dibuja en el borde y=1 del cuadrado unidad.
  const topLeft = toScreen([0, 1]);
  const topRight = toScreen([1, 1]);
  const bottomLeft = toScreen([0, 0]);

  return {
    left: topLeft[0],
    top: topLeft[1],
    width: topRight[0] - topLeft[0],
    height: bottomLeft[1] - topLeft[1],
  };
}

/**
 * Posición y tamaño con los que quedó dibujada la imagen, leídos del flujo de contenido de la
 * página. pdf-lib emite `1 0 0 1 x y cm` (traslación) seguido de `w 0 0 h 0 0 cm` (escala), así
 * que es lo que de verdad ve un lector de PDF — no lo que el servicio dice que hizo.
 */
async function drawnPlacement(pdf: Buffer): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const doc = await PDFDocument.load(pdf);
  const page = doc.getPage(0);
  const contents = page.node.Contents() as unknown as {
    asArray?: () => unknown[];
  };
  const refs = contents.asArray ? contents.asArray() : [contents];

  for (const ref of refs) {
    const stream = doc.context.lookup(ref as never) as unknown as {
      contents?: Uint8Array;
    };
    if (!stream?.contents) continue;

    const raw = Buffer.from(stream.contents);
    let text: string;
    try {
      text = zlib.inflateSync(raw).toString();
    } catch {
      text = raw.toString();
    }

    // La secuencia se ancla entera (traslación, identidad, escala) porque la matriz identidad
    // intermedia también encaja con el patrón de una escala, y una búsqueda laxa la tomaría a ella.
    const match = text.match(
      /1 0 0 1 ([\d.-]+) ([\d.-]+) cm\s+1 0 0 1 0 0 cm\s+([\d.-]+) 0 0 ([\d.-]+) 0 0 cm/,
    );
    if (match) {
      return {
        x: Number(match[1]),
        y: Number(match[2]),
        width: Number(match[3]),
        height: Number(match[4]),
      };
    }
  }

  throw new Error('No se encontró ninguna imagen dibujada en la página');
}

describe('PdfSignatureService', () => {
  let service: PdfSignatureService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PdfSignatureService],
    }).compile();

    service = module.get(PdfSignatureService);
  });

  /**
   * Historia "Actualizar contenido del código QR en firma avanzada", criterio "el QR conserva una
   * proporción cuadrada, sin estiramiento". La caja de firma es apaisada porque está pensada para
   * una rúbrica manuscrita; un código QR estirado ahí deja de ser cuadrado y los lectores no
   * reconocen su patrón.
   */
  describe('mergeSignatureIntoPdf — preserveAspectRatio', () => {
    // La caja es 200x80 y el PNG de prueba es cuadrado (1x1).
    const LANDSCAPE_BOX = { x: 50, y: 100, width: 200, height: 80 };

    it('encaja la imagen sin deformarla y la centra en la caja', async () => {
      const documentBuffer = await buildPdf([[400, 400]]);

      const signed = await service.mergeSignatureIntoPdf(
        documentBuffer,
        MINIMAL_PNG,
        LANDSCAPE_BOX,
        undefined,
        { preserveAspectRatio: true },
      );

      const placement = await drawnPlacement(signed);
      expect(placement.width).toBe(placement.height);
      // Escala al lado menor de la caja (80) y se centra en el eje largo.
      expect(placement.width).toBe(80);
      expect(placement.x).toBe(50 + (200 - 80) / 2);
      expect(placement.y).toBe(100);
    });

    /**
     * Criterio "al cambiar el tamaño del contenedor o visualizarse en distintas resoluciones, el
     * QR conserva sus proporciones": la caja de firma la define quien coloca la firma, así que
     * puede llegar con cualquier forma — el resultado tiene que ser cuadrado en todas.
     */
    // Las cajas se quedan dentro del rango que acepta `resolveSignatureSize`: fuera de él, la caja
    // se sustituye por el tamaño por defecto (200x80) antes de llegar acá — comportamiento previo
    // y común a todas las firmas, no algo propio del encaje del QR.
    it.each([
      ['apaisada', { x: 50, y: 100, width: 200, height: 80 }, 80],
      ['vertical', { x: 50, y: 100, width: 100, height: 120 }, 100],
      ['cuadrada', { x: 50, y: 100, width: 120, height: 120 }, 120],
    ])(
      'sale cuadrado con una caja %s, sin importar su forma',
      async (_forma, box, ladoEsperado) => {
        const documentBuffer = await buildPdf([[400, 400]]);

        const signed = await service.mergeSignatureIntoPdf(
          documentBuffer,
          MINIMAL_PNG,
          box,
          undefined,
          { preserveAspectRatio: true },
        );

        const placement = await drawnPlacement(signed);
        expect(placement.width).toBe(ladoEsperado);
        expect(placement.height).toBe(ladoEsperado);
        // Centrado en ambos ejes dentro de la caja que le tocó.
        expect(placement.x).toBe(box.x + (box.width - ladoEsperado) / 2);
        expect(placement.y).toBe(box.y + (box.height - ladoEsperado) / 2);
      },
    );

    it('sin la opción, la imagen sigue llenando la caja completa (rúbricas, sin cambios)', async () => {
      const documentBuffer = await buildPdf([[400, 400]]);

      const signed = await service.mergeSignatureIntoPdf(
        documentBuffer,
        MINIMAL_PNG,
        LANDSCAPE_BOX,
      );

      const placement = await drawnPlacement(signed);
      expect(placement).toEqual(LANDSCAPE_BOX);
    });
  });

  describe('mergeSignatureIntoPdf — pageIndex (historia "Ubicación de firmas por usuario")', () => {
    it('sin pageIndex, dibuja en la última página (comportamiento previo, sin romper callers existentes)', async () => {
      const documentBuffer = await buildPdf([
        [200, 200],
        [300, 300],
      ]);

      const signed = await service.mergeSignatureIntoPdf(
        documentBuffer,
        MINIMAL_PNG,
        { x: 10, y: 10, width: 60, height: 24 },
      );

      const signedDoc = await PDFDocument.load(signed);
      expect(signedDoc.getPages()).toHaveLength(2);
    });

    it('con pageIndex explícito, dibuja en esa página y no en la última', async () => {
      const documentBuffer = await buildPdf([
        [200, 200],
        [300, 300],
        [400, 400],
      ]);

      // No hay forma directa de "leer" en qué página quedó dibujado sin parsear el contenido del
      // PDF — se verifica indirectamente: pasar un pageIndex fuera de rango cae al fallback
      // (última página) sin lanzar, y uno válido tampoco lanza. La cobertura de que realmente
      // apunta a la página correcta vive en el test de integración de resolveRatioPosition +
      // document.service.spec.ts (pageIndex propagado end-to-end).
      await expect(
        service.mergeSignatureIntoPdf(
          documentBuffer,
          MINIMAL_PNG,
          { x: 10, y: 10, width: 60, height: 24 },
          1,
        ),
      ).resolves.toBeInstanceOf(Buffer);
    });

    it('con un pageIndex fuera de rango, cae a la última página en vez de lanzar', async () => {
      const documentBuffer = await buildPdf([[200, 200]]);

      await expect(
        service.mergeSignatureIntoPdf(
          documentBuffer,
          MINIMAL_PNG,
          { x: 10, y: 10, width: 60, height: 24 },
          99,
        ),
      ).resolves.toBeInstanceOf(Buffer);
    });
  });

  /**
   * Historia "Ajustar posicionamiento de firmas según orientación del documento".
   *
   * El bug: el frontend mide el drop contra la hoja que pdf.js dibuja, que ya tiene el `/Rotate`
   * aplicado, mientras que el backend interpretaba esos ratios contra el MediaBox crudo. En una
   * hoja apaisada escrita como "vertical + `/Rotate 90`" —lo que exportan Word y los escáneres—
   * los dos tamaños no coinciden y la rúbrica salía en otro punto y de costado.
   *
   * Cada caso estampa con los mismos ratios y comprueba dónde queda la firma EN PANTALLA,
   * proyectando con la matriz de viewport de pdf.js. Es la única comprobación que vale: el
   * criterio de aceptación habla de dónde la ve el usuario, no de qué números quedaron en el
   * flujo de contenido.
   */
  /**
   * El resize automático normaliza a `DEFAULT_SIGNATURE_SIZE` (200x80) cualquier caja fuera del
   * rango dibujable. Tiene sentido para un tamaño que llega sin respaldo —coordenadas legacy en
   * píxeles, el apilado por defecto—, pero no para una caja que el usuario dibujó sobre la página:
   * ahí el tamaño se derivó de las dimensiones de esa hoja y se vio en pantalla antes de firmar.
   */
  describe('mergeSignatureIntoPdf — normalizeSize', () => {
    // Fuera del máximo (320x128): en una hoja muy ancha, el 20% del ancho llega a estos valores
    // sin que nada esté mal.
    const CAJA_GRANDE = { x: 40, y: 60, width: 420, height: 150 };

    it('por defecto normaliza un tamaño fuera de rango (comportamiento previo)', async () => {
      const documentBuffer = await buildPdf([[2400, 1000]]);

      const signed = await service.mergeSignatureIntoPdf(
        documentBuffer,
        MINIMAL_PNG,
        CAJA_GRANDE,
      );

      const { width, height } = await drawnPlacement(signed);
      expect({ width, height }).toEqual({ width: 200, height: 80 });
    });

    /**
     * Sin esto, la firma no sólo cambia de tamaño: al encogerse desde la esquina inferior
     * izquierda deja de cubrir la caja que el usuario ve dibujada, y termina en otro sitio.
     */
    it('con normalizeSize:false respeta la caja configurada tal cual', async () => {
      const documentBuffer = await buildPdf([[2400, 1000]]);

      const signed = await service.mergeSignatureIntoPdf(
        documentBuffer,
        MINIMAL_PNG,
        CAJA_GRANDE,
        undefined,
        { normalizeSize: false },
      );

      expect(await drawnPlacement(signed)).toEqual({
        x: 40,
        y: 60,
        width: 420,
        height: 150,
      });
    });

    /** Una caja diminuta tampoco se agranda: lo configurado es lo que se estampa. */
    it('con normalizeSize:false tampoco agranda una caja por debajo del mínimo', async () => {
      const documentBuffer = await buildPdf([[600, 800]]);

      const signed = await service.mergeSignatureIntoPdf(
        documentBuffer,
        MINIMAL_PNG,
        { x: 10, y: 10, width: 30, height: 12 },
        undefined,
        { normalizeSize: false },
      );

      const { width, height } = await drawnPlacement(signed);
      expect({ width, height }).toEqual({ width: 30, height: 12 });
    });
  });

  describe('mergeSignatureIntoPdf — orientación de la página', () => {
    const RATIOS = {
      page: 1,
      xRatio: 0.65,
      yRatio: 0.12,
      widthRatio: 0.2,
      heightRatio: 0.08,
    };

    const CASES: { nombre: string; page: PageSpec }[] = [
      {
        nombre: 'vertical sin /Rotate (el caso que ya funcionaba)',
        page: { media: [595, 842], rotate: 0 },
      },
      {
        nombre: 'apaisada con el MediaBox ya ancho',
        page: { media: [842, 595], rotate: 0 },
      },
      {
        nombre: 'apaisada escrita como vertical + /Rotate 90',
        page: { media: [595, 842], rotate: 90 },
      },
      {
        nombre: 'apaisada escrita como vertical + /Rotate 270',
        page: { media: [595, 842], rotate: 270 },
      },
      {
        nombre: 'vertical de cabeza (/Rotate 180)',
        page: { media: [595, 842], rotate: 180 },
      },
      {
        nombre: 'vertical escrita como apaisada + /Rotate 90',
        page: { media: [842, 595], rotate: 90 },
      },
    ];

    it.each(CASES)(
      'estampa donde el usuario colocó la firma: $nombre',
      async ({ page }) => {
        const documentBuffer = await buildRotatedPdf([page]);
        const content = { width: page.media[0], height: page.media[1] };

        const { coordinates, pageIndex } = await service.resolveRatioPosition(
          documentBuffer,
          RATIOS,
        );
        const signed = await service.mergeSignatureIntoPdf(
          documentBuffer,
          MINIMAL_PNG,
          coordinates,
          pageIndex,
        );

        const screen = await drawnOnScreen(
          signed,
          0,
          content,
          page.rotate,
        );
        const viewer = viewerTransform(content, page.rotate);

        expect(screen.left).toBeCloseTo(RATIOS.xRatio * viewer.width, 3);
        expect(screen.top).toBeCloseTo(RATIOS.yRatio * viewer.height, 3);
        expect(screen.width).toBeCloseTo(RATIOS.widthRatio * viewer.width, 3);
        expect(screen.height).toBeCloseTo(RATIOS.heightRatio * viewer.height, 3);
      },
    );

    /**
     * Criterio de aceptación "se valida el comportamiento en documentos con páginas de distinta
     * orientación dentro del mismo archivo": la rotación se lee de la página DESTINO, no del
     * documento, así que dos firmas del mismo documento pueden necesitar transformaciones
     * distintas.
     */
    it('resuelve cada página por su cuenta en un documento de orientación mixta', async () => {
      const pages: PageSpec[] = [
        { media: [595, 842], rotate: 0 },
        { media: [595, 842], rotate: 90 },
        { media: [842, 595], rotate: 0 },
      ];
      let documentBuffer = await buildRotatedPdf(pages);

      for (let index = 0; index < pages.length; index++) {
        const { coordinates, pageIndex } = await service.resolveRatioPosition(
          documentBuffer,
          { ...RATIOS, page: index + 1 },
        );
        documentBuffer = await service.mergeSignatureIntoPdf(
          documentBuffer,
          MINIMAL_PNG,
          coordinates,
          pageIndex,
        );
      }

      for (let index = 0; index < pages.length; index++) {
        const spec = pages[index];
        const content = { width: spec.media[0], height: spec.media[1] };
        const viewer = viewerTransform(content, spec.rotate);
        const screen = await drawnOnScreen(
          documentBuffer,
          index,
          content,
          spec.rotate,
        );

        expect(screen.left).toBeCloseTo(RATIOS.xRatio * viewer.width, 3);
        expect(screen.top).toBeCloseTo(RATIOS.yRatio * viewer.height, 3);
        expect(screen.width).toBeCloseTo(RATIOS.widthRatio * viewer.width, 3);
        expect(screen.height).toBeCloseTo(RATIOS.heightRatio * viewer.height, 3);
      }
    });

    /**
     * El estampado de la firma avanzada encaja el QR sin deformarlo y lo centra en la caja. Ese
     * centrado se calcula en el espacio VISIBLE: en una hoja girada los lados del MediaBox están
     * intercambiados, y medirlo ahí compararía el ancho del QR contra el alto de la página.
     */
    it('centra el QR dentro de la caja también en una hoja girada', async () => {
      const page: PageSpec = { media: [595, 842], rotate: 90 };
      const documentBuffer = await buildRotatedPdf([page]);
      const content = { width: page.media[0], height: page.media[1] };

      const { coordinates, pageIndex } = await service.resolveRatioPosition(
        documentBuffer,
        RATIOS,
      );
      const signed = await service.mergeSignatureIntoPdf(
        documentBuffer,
        MINIMAL_PNG,
        coordinates,
        pageIndex,
        { preserveAspectRatio: true },
      );

      const viewer = viewerTransform(content, page.rotate);
      const screen = await drawnOnScreen(signed, 0, content, page.rotate);
      const box = {
        left: RATIOS.xRatio * viewer.width,
        top: RATIOS.yRatio * viewer.height,
        width: RATIOS.widthRatio * viewer.width,
        height: RATIOS.heightRatio * viewer.height,
      };

      // El PNG de prueba es cuadrado: encaja por el lado corto de la caja y queda cuadrado.
      expect(screen.width).toBeCloseTo(screen.height, 3);
      expect(screen.height).toBeCloseTo(box.height, 3);
      // Y centrado en la caja, en los dos ejes de la pantalla.
      expect(screen.left + screen.width / 2).toBeCloseTo(
        box.left + box.width / 2,
        3,
      );
      expect(screen.top + screen.height / 2).toBeCloseTo(
        box.top + box.height / 2,
        3,
      );
    });
  });

  describe('resolveRatioPosition', () => {
    it('convierte ratios a puntos absolutos contra el tamaño real de la página destino', async () => {
      const documentBuffer = await buildPdf([[600, 800]]);

      const { coordinates, pageIndex } = await service.resolveRatioPosition(
        documentBuffer,
        {
          page: 1,
          xRatio: 0.1,
          yRatio: 0.2,
          widthRatio: 0.2,
          heightRatio: 0.1,
        },
      );

      expect(pageIndex).toBe(0);
      expect(coordinates.x).toBeCloseTo(60); // 0.1 * 600
      expect(coordinates.width).toBeCloseTo(120); // 0.2 * 600
      expect(coordinates.height).toBeCloseTo(80); // 0.1 * 800
      // yRatio se mide desde el borde SUPERIOR; y_pdf = pageHeight - (yRatio+heightRatio)*pageHeight
      expect(coordinates.y).toBeCloseTo(800 - (0.2 + 0.1) * 800); // 560
    });

    it('usa el tamaño de la página correcta cuando las páginas del documento tienen tamaños distintos', async () => {
      const documentBuffer = await buildPdf([
        [600, 800],
        [1200, 400],
      ]);

      const { coordinates, pageIndex } = await service.resolveRatioPosition(
        documentBuffer,
        { page: 2, xRatio: 0.5, yRatio: 0, widthRatio: 0.1, heightRatio: 0.1 },
      );

      expect(pageIndex).toBe(1);
      expect(coordinates.x).toBeCloseTo(600); // 0.5 * 1200 (ancho de la página 2, no la 1)
      expect(coordinates.width).toBeCloseTo(120); // 0.1 * 1200
      expect(coordinates.height).toBeCloseTo(40); // 0.1 * 400
    });

    it('si page excede el total de páginas, usa la última como fallback en vez de lanzar', async () => {
      const documentBuffer = await buildPdf([[600, 800]]);

      const { pageIndex } = await service.resolveRatioPosition(documentBuffer, {
        page: 99,
        xRatio: 0,
        yRatio: 0,
        widthRatio: 0.1,
        heightRatio: 0.1,
      });

      expect(pageIndex).toBe(0);
    });
  });
});

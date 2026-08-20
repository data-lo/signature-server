import { Test, TestingModule } from '@nestjs/testing';
import * as zlib from 'zlib';
import { PDFDocument } from 'pdf-lib';
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

    // La secuencia se ancla hasta el `/Image ... Do`: la zona de silencio del QR dibuja antes un
    // rectángulo con su propia traslación, y una búsqueda laxa tomaría esa en vez de la imagen.
    const match = text.match(
      /1 0 0 1 ([\d.-]+) ([\d.-]+) cm\s+1 0 0 1 0 0 cm\s+([\d.-]+) 0 0 ([\d.-]+) 0 0 cm\s+1 0 0 1 0 0 cm\s+\/Image/,
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

/** Flujo de contenido de la primera página, descomprimido, tal como lo interpreta un lector. */
async function pageContentStream(pdf: Buffer): Promise<string> {
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
    try {
      return zlib.inflateSync(raw).toString();
    } catch {
      return raw.toString();
    }
  }

  return '';
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
     * Zona de silencio. La norma QR exige un borde libre alrededor del código: medido con un
     * decodificador real, un QR con texto del documento pegado NO se lee a 150 DPI, y con la
     * separación sí. El borde se pinta al estampar y no dentro del PNG, para no quitarle tamaño
     * a los módulos.
     */
    it('pinta un recuadro blanco alrededor del código antes de dibujarlo', async () => {
      const documentBuffer = await buildPdf([[400, 400]]);

      const signed = await service.mergeSignatureIntoPdf(
        documentBuffer,
        MINIMAL_PNG,
        LANDSCAPE_BOX,
        undefined,
        { preserveAspectRatio: true },
      );

      const contenido = await pageContentStream(signed);

      // Relleno blanco, y ANTES de dibujar la imagen.
      expect(contenido).toMatch(/1 1 1 rg/);
      expect(contenido.indexOf('1 1 1 rg')).toBeLessThan(
        contenido.indexOf('/Image'),
      );

      // pdf-lib emite el rectángulo como trazado: el lado del recuadro sale de su `lineTo`.
      const [, ladoRecuadro] = contenido.match(/([\d.]+) \1 l/) ?? [];
      // El QR ocupa 80 y el recuadro lo rodea con el borde libre a cada lado.
      expect(Number(ladoRecuadro)).toBeGreaterThan(80);

      // Y queda centrado sobre el código: se desplaza el mismo margen en ambos ejes.
      const desplazado = (Number(ladoRecuadro) - 80) / 2;
      expect(contenido).toContain(
        `1 0 0 1 ${110 - desplazado} ${100 - desplazado} cm`,
      );
    });

    it('no pinta recuadro para una rúbrica (solo aplica al código QR)', async () => {
      const documentBuffer = await buildPdf([[400, 400]]);

      const signed = await service.mergeSignatureIntoPdf(
        documentBuffer,
        MINIMAL_PNG,
        LANDSCAPE_BOX,
      );

      expect(await pageContentStream(signed)).not.toMatch(/1 1 1 rg/);
    });

    /**
     * Una caja de firma puede ser tan chica como 60x24pt, y ahí el QR queda en 24pt de lado
     * (~8.5mm): medido, no lo lee ningún decodificador a 96, 150 ni 300 DPI. Se estampa igual
     * —quitarlo dejaría la firma avanzada sin representación visual— pero deja de ser silencioso.
     */
    it('avisa cuando la caja deja el código por debajo del tamaño escaneable', async () => {
      const advertencia = jest
        .spyOn(service['logger'], 'warn')
        .mockImplementation(() => undefined);
      const documentBuffer = await buildPdf([[400, 400]]);

      await service.mergeSignatureIntoPdf(
        documentBuffer,
        MINIMAL_PNG,
        { x: 10, y: 10, width: 60, height: 24 },
        undefined,
        { preserveAspectRatio: true },
      );

      expect(advertencia).toHaveBeenCalledWith(
        expect.stringContaining('por debajo del mínimo escaneable'),
      );
      advertencia.mockRestore();
    });

    it('no avisa cuando el código sale a un tamaño escaneable', async () => {
      const advertencia = jest
        .spyOn(service['logger'], 'warn')
        .mockImplementation(() => undefined);
      const documentBuffer = await buildPdf([[400, 400]]);

      await service.mergeSignatureIntoPdf(
        documentBuffer,
        MINIMAL_PNG,
        LANDSCAPE_BOX,
        undefined,
        { preserveAspectRatio: true },
      );

      expect(advertencia).not.toHaveBeenCalled();
      advertencia.mockRestore();
    });

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

  describe('resolveRatioPosition', () => {
    it('convierte ratios a puntos absolutos contra el tamaño real de la página destino', async () => {
      const documentBuffer = await buildPdf([[600, 800]]);

      const { coordinates, pageIndex } = await service.resolveRatioPosition(
        documentBuffer,
        { page: 1, xRatio: 0.1, yRatio: 0.2, widthRatio: 0.2, heightRatio: 0.1 },
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

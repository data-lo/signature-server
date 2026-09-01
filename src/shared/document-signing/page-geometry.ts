import { SignatureCoordinates } from './interfaces/signature-coordinates.interface';

/**
 * Geometría de una página según la VE el usuario, no según cómo está guardada.
 *
 * Un PDF describe cada página con dos cosas independientes: su MediaBox (el tamaño del lienzo
 * donde vive el contenido) y su `/Rotate` (cuántos grados en sentido horario debe girarla el
 * visor antes de mostrarla). Una hoja apaisada puede estar escrita de las dos maneras:
 *
 *  - MediaBox ya ancho (842x595) y `/Rotate 0` — la escriben InDesign, LaTeX, pdfmake;
 *  - MediaBox vertical (595x842) y `/Rotate 90` — la escriben los escáneres y casi todo lo que
 *    exporta Word/Excel apaisado, que es el caso que reportó el usuario.
 *
 * pdf.js —el visor del frontend— aplica `/Rotate` al construir el viewport, así que el usuario
 * arrastra la firma sobre una hoja de 842x595 en los dos casos y los ratios que persistimos son
 * relativos a ESA hoja. pdf-lib NO lo aplica: `page.getSize()` devuelve el MediaBox crudo y
 * `drawImage` dibuja en el espacio del contenido, sin girar. Interpretar los ratios contra el
 * MediaBox era exactamente el bug: en el segundo caso el backend creía estar sobre una hoja
 * vertical de 595x842 y estampaba la rúbrica en otro sitio y de costado.
 *
 * Este módulo es la traducción entre los dos espacios, y es pura a propósito: la matemática se
 * prueba con números, sin cargar un PDF ni rasterizar nada.
 */

/** Los cuatro valores que admite `/Rotate` una vez normalizado. */
export type PageRotation = 0 | 90 | 180 | 270;

/** Tamaño del MediaBox (lo que devuelve `PDFPage.getSize()`), sin `/Rotate` aplicado. */
export interface ContentPageSize {
  width: number;
  height: number;
}

/** Orientación de la hoja TAL COMO SE VE, que es la que le importa al usuario. */
export type PageOrientation = 'PORTRAIT' | 'LANDSCAPE';

/**
 * Colocación lista para `PDFPage.drawImage`: además del rectángulo, el ángulo con el que hay que
 * dibujar la imagen para que salga derecha una vez que el visor gire la página.
 */
export interface StampPlacement extends SignatureCoordinates {
  /** Grados a pasar a `degrees()` de pdf-lib. 0 en una página sin `/Rotate`. */
  rotate: number;
}

/**
 * Normaliza el ángulo crudo de `/Rotate` a uno de los cuatro cuadrantes.
 *
 * El valor puede venir negativo o mayor a 360 (la especificación sólo exige que sea múltiplo de
 * 90), y pdf-lib lo devuelve tal como está escrito en el archivo. Un ángulo que no sea múltiplo
 * de 90 —archivo malformado— se redondea al cuadrante más cercano en vez de lanzar: preferimos
 * una firma casi derecha a una firma que no se estampa.
 */
export function normalizePageRotation(angle: number): PageRotation {
  const quadrant = Math.round(angle / 90) % 4;
  return (((quadrant + 4) % 4) * 90) as PageRotation;
}

/**
 * Tamaño de la hoja tal como se ve: con `/Rotate 90` o `270` los lados se intercambian respecto
 * del MediaBox. Es contra ESTE tamaño que se interpretan los ratios del frontend.
 */
export function displayedPageSize(
  content: ContentPageSize,
  rotation: PageRotation,
): ContentPageSize {
  return rotation === 90 || rotation === 270
    ? { width: content.height, height: content.width }
    : { width: content.width, height: content.height };
}

/**
 * Orientación de la hoja tal como se ve. Una hoja cuadrada cuenta como vertical: no hay nada que
 * transformar y es el caso que ya funcionaba.
 */
export function pageOrientation(
  content: ContentPageSize,
  rotation: PageRotation,
): PageOrientation {
  const displayed = displayedPageSize(content, rotation);
  return displayed.width > displayed.height ? 'LANDSCAPE' : 'PORTRAIT';
}

/**
 * Convierte un rectángulo del espacio VISIBLE (el que ve el usuario y contra el que se midieron
 * los ratios, origen en la esquina inferior izquierda) al espacio del CONTENIDO que usa
 * `drawImage`.
 *
 * La regla es una sola, aplicada cuatro veces: **el ancla es siempre la esquina inferior
 * izquierda de la caja visible, trasladada al espacio del contenido**, porque `drawImage` ancla
 * ahí la esquina `(0,0)` de la imagen y gira alrededor de ese punto. El ángulo es el que deja la
 * rúbrica derecha DESPUÉS de que el visor gire la página.
 *
 * Los dos giros y los dos ángulos salen de medir, no de deducir: se leyó con pdf.js la matriz de
 * viewport de cada `/Rotate` y la CTM que `drawImage` emite por cada ángulo. Ojo con el signo,
 * porque es contraintuitivo y fue el error de la primera versión: `/Rotate 90` necesita
 * `degrees(+90)` y `/Rotate 270` necesita `degrees(-90)`. Un ángulo invertido produce la caja en
 * el lugar CORRECTO pero con la rúbrica de cabeza, que es un fallo fácil de pasar por alto si
 * sólo se compara el rectángulo.
 *
 * Con `rotation = 0` devuelve el rectángulo intacto y `rotate: 0`. Ese es el camino de todo
 * documento vertical sin `/Rotate`, el que ya funcionaba: la conversión es la identidad, no un
 * caso particular que haya que confiar en que esté bien.
 */
export function toContentSpace(
  visible: SignatureCoordinates,
  content: ContentPageSize,
  rotation: PageRotation,
): StampPlacement {
  const { x, y, width, height, opacity } = visible;
  const { width: contentWidth, height: contentHeight } = content;
  const box = { width, height, opacity };

  switch (rotation) {
    // La hoja se ve girada un cuarto de vuelta: el eje horizontal visible corre a lo largo del
    // eje Y del contenido, así que el ancho visible se convierte en alto del contenido.
    case 90:
      return { x: contentWidth - y, y: x, ...box, rotate: 90 };
    case 180:
      return { x: contentWidth - x, y: contentHeight - y, ...box, rotate: 180 };
    case 270:
      return { x: y, y: contentHeight - x, ...box, rotate: -90 };
    default:
      return { x, y, ...box, rotate: 0 };
  }
}

/**
 * Ratios 0-1 del frontend -> rectángulo en el espacio VISIBLE, en puntos.
 *
 * `yRatio` se mide desde el borde SUPERIOR (así lo mide el DOM al soltar la firma) y el PDF mide
 * desde el inferior, de ahí la resta.
 */
export function toVisibleRect(
  ratios: {
    xRatio: number;
    yRatio: number;
    widthRatio: number;
    heightRatio: number;
    opacity?: number;
  },
  displayed: ContentPageSize,
): SignatureCoordinates {
  return {
    x: ratios.xRatio * displayed.width,
    y: displayed.height - (ratios.yRatio + ratios.heightRatio) * displayed.height,
    width: ratios.widthRatio * displayed.width,
    height: ratios.heightRatio * displayed.height,
    opacity: ratios.opacity,
  };
}

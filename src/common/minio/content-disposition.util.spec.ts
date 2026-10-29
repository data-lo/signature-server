import {
  buildAttachmentDisposition,
  sanitizeDownloadFileName,
} from './content-disposition.util';

describe('sanitizeDownloadFileName', () => {
  it('conserva el nombre del documento tal cual cuando ya trae extensión', () => {
    expect(sanitizeDownloadFileName('Contrato de servicios.pdf')).toBe(
      'Contrato de servicios.pdf',
    );
  });

  it('agrega la extensión cuando el nombre no la trae', () => {
    expect(sanitizeDownloadFileName('Contrato de servicios')).toBe(
      'Contrato de servicios.pdf',
    );
  });

  /** `.PDF` ya es un PDF: agregarle otra extensión daría "Contrato.PDF.pdf". */
  it('reconoce la extensión sin importar mayúsculas', () => {
    expect(sanitizeDownloadFileName('Contrato.PDF')).toBe('Contrato.PDF');
  });

  /**
   * Un nombre con `../` o con separadores haría que el navegador intente escribir fuera de la
   * carpeta de descargas. El nombre lo escribe quien sube el documento, así que no es dato de
   * confianza aunque venga de nuestra propia base.
   */
  it('neutraliza separadores de ruta', () => {
    expect(sanitizeDownloadFileName('../../etc/passwd')).toBe('etc passwd.pdf');
    expect(sanitizeDownloadFileName('carpeta\\archivo.pdf')).toBe(
      'carpeta archivo.pdf',
    );
  });

  /** Una comilla cerraría el `filename="..."` de la cabecera antes de tiempo. */
  it('quita comillas y caracteres que Windows prohíbe', () => {
    expect(sanitizeDownloadFileName('re"porte<final>?.pdf')).toBe(
      're porte final .pdf',
    );
  });

  /** Un salto de línea permitiría inyectar una cabecera HTTP entera. */
  it('quita los caracteres de control', () => {
    expect(sanitizeDownloadFileName('contrato\r\nX-Malo: 1.pdf')).toBe(
      'contrato X-Malo 1.pdf',
    );
  });

  /** Windows rechaza un nombre que termina en punto o espacio. */
  it('recorta espacios y puntos de los bordes', () => {
    expect(sanitizeDownloadFileName('  .contrato.  ')).toBe('contrato.pdf');
  });

  /**
   * Criterio "si el nombre del documento no está disponible, se utiliza un nombre alternativo
   * legible y controlado". Legible y sin el ID adentro: el ID es justamente lo que se quiere
   * dejar de mostrar.
   */
  it.each([
    ['vacío', ''],
    ['sólo espacios', '   '],
    ['nulo', null],
    ['indefinido', undefined],
    ['sólo caracteres prohibidos', '///'],
  ])('cae a un nombre legible cuando el nombre es %s', (_caso, entrada) => {
    expect(sanitizeDownloadFileName(entrada)).toBe('documento.pdf');
  });
});

describe('buildAttachmentDisposition', () => {
  /**
   * El caso normal en español. Sin `filename*`, la acentuada llega rota: la cabecera sólo admite
   * ASCII. Y sin el `filename` en ASCII, un cliente viejo se queda sin nombre.
   */
  it('publica el nombre en ASCII y en UTF-8, como pide el RFC 6266', () => {
    const disposition = buildAttachmentDisposition(
      'Contrato de prestación de servicios.pdf',
    );

    expect(disposition).toBe(
      'attachment; filename="Contrato de prestacion de servicios.pdf"; ' +
        "filename*=UTF-8''Contrato%20de%20prestaci%C3%B3n%20de%20servicios.pdf",
    );
  });

  it('conserva la letra base al pasar los acentos a ASCII', () => {
    expect(buildAttachmentDisposition('Año ñandú.pdf')).toContain(
      'filename="Ano nandu.pdf"',
    );
  });

  /** La versión ASCII nunca queda vacía, ni con un nombre que no tiene una sola letra latina. */
  it('no deja el nombre ASCII vacío con un nombre íntegramente no latino', () => {
    const disposition = buildAttachmentDisposition('文書.pdf');

    expect(disposition).toContain('filename="__.pdf"');
    expect(disposition).toContain("filename*=UTF-8''%E6%96%87%E6%9B%B8.pdf");
  });

  it('siempre marca la respuesta como descarga', () => {
    expect(buildAttachmentDisposition('reporte')).toMatch(/^attachment; /);
  });
});

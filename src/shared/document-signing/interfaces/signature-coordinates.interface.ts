/**
 * Rectángulo donde va la firma, en puntos y **en el espacio VISIBLE de la página**: el mismo que
 * ve el usuario en el visor, con el origen en la esquina inferior izquierda de la hoja tal como
 * se muestra.
 *
 * Visible y no "del contenido" a propósito. Una página puede llevar `/Rotate`, y entonces su
 * MediaBox y lo que se ve en pantalla no coinciden ni en tamaño ni en ejes. Todo lo que decide
 * dónde va una firma —los ratios del frontend, el encaje del QR, el apilado automático— razona
 * sobre lo que se ve; la traducción al espacio del contenido ocurre en un solo lugar, dentro de
 * `PdfSignatureService.mergeSignatureIntoPdf`, justo antes de dibujar (ver `page-geometry.ts`).
 *
 * En una página sin `/Rotate` —la enorme mayoría, incluidas las apaisadas que ya traen el
 * MediaBox ancho— los dos espacios son el mismo y la traducción es la identidad.
 */
export interface SignatureCoordinates {
  x: number;
  y: number;
  width: number;
  height: number;
  // Nivel de transparencia de la firma: 0.0 = invisible, 1.0 = opaco. Por defecto 1.0.
  opacity?: number;
}

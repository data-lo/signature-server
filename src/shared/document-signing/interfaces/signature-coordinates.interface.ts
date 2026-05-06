export interface SignatureCoordinates {
  x: number;
  y: number;
  width: number;
  height: number;
  // Nivel de transparencia de la firma: 0.0 = invisible, 1.0 = opaco. Por defecto 1.0.
  opacity?: number;
}

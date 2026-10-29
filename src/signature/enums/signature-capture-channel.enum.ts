/**
 * Por dónde entra la firma manuscrita en un intento de captura.
 *
 * No es una preferencia de interfaz: decide qué pasos exige el backend. `DESKTOP` acepta el PNG
 * directamente sobre la sesión, mientras que `MOBILE_QR` obliga a reclamarla primero desde el
 * teléfono (`POST /claim`), que es donde se comprueba que quien escaneó el QR es el mismo
 * usuario que lo generó.
 */
export enum SIGNATURE_CAPTURE_CHANNEL_ENUM {
  /** El usuario dibuja su firma en el canvas de la misma PC donde inició sesión. */
  DESKTOP = 'DESKTOP',
  /** El usuario escanea el QR de la PC y dibuja su firma en el navegador del teléfono. */
  MOBILE_QR = 'MOBILE_QR',
}

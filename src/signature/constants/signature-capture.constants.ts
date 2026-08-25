/**
 * Cuánto vive un intento de captura.
 *
 * Diez minutos es el equilibrio entre las dos cosas que pueden salir mal. Más corto, y una
 * persona que tarda en desbloquear el teléfono, buscar la cámara y dibujar su firma con el dedo
 * se queda sin sesión a medio flujo. Más largo, y un QR que quedó en pantalla —o fotografiado
 * por alguien que pasaba— sigue siendo un enlace vivo hacia la cuenta mucho después de que el
 * usuario se levantó de la computadora.
 */
export const SIGNATURE_CAPTURE_SESSION_TTL_MINUTES = 10;

/**
 * Página del frontend que abre el QR en el teléfono. Recibe el token como query param y lo
 * canjea contra `POST /api/v1/signature-capture-sessions/claim`.
 *
 * Es una ruta protegida del frontend: si el teléfono no tiene sesión, el middleware manda al
 * usuario a iniciarla antes de mostrar el canvas. Eso es parte del diseño y no un estorbo — es
 * lo que hace que un QR fotografiado por un tercero no le sirva para nada.
 */
export const SIGNATURE_CAPTURE_MOBILE_PATH = '/signature-capture';

/**
 * Nombre del campo del multipart que trae el PNG.
 *
 * Uno solo, y distinto del `signatureImage` de `PUT /api/v1/users/me/signature`: esa ruta acepta
 * además la identificación oficial, mientras que acá lo único que puede llegar es la rúbrica que
 * el usuario acaba de dibujar.
 */
export const SIGNATURE_CAPTURE_FILE_FIELD = 'signature';

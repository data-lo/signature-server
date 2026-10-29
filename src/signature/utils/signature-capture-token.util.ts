import { createHash, randomBytes } from 'crypto';

/**
 * 32 bytes de aleatoriedad criptográfica: 256 bits, el mismo orden que una llave de sesión. El
 * token viaja dentro del QR y es lo único que separa a un tercero de reclamar la sesión, así
 * que adivinarlo por fuerza bruta tiene que ser inviable aunque el atacante conozca el formato.
 */
const TOKEN_BYTES = 32;

/**
 * Token de un solo uso para el QR.
 *
 * `base64url` y no `base64`: el valor se pega como query param de la URL que codifica el QR, y
 * `+`, `/` y `=` obligarían a escapar (y a que cualquier lector que no lo haga bien entregue un
 * token corrupto). Nunca es un JWT ni lleva datos del usuario dentro — es un identificador
 * opaco, y lo que dice quién es el dueño de la sesión es la fila en base de datos.
 */
export function generateSignatureCaptureToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Lo que se persiste en `token_hash`.
 *
 * SHA-256 a secas, sin salt ni coste configurable, y es lo correcto acá: no es una contraseña
 * elegida por una persona (corta, reutilizada, adivinable por diccionario) sino un valor
 * aleatorio de 256 bits con minutos de vida. Un hash rápido y determinista es justamente lo que
 * permite buscar la sesión por token con un índice, sin abrir ninguna vía de ataque real.
 */
export function hashSignatureCaptureToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

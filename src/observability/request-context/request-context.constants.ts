/**
 * Header de correlación de cada petición HTTP. Se acepta del cliente si cumple
 * `REQUEST_ID_PATTERN` y se devuelve SIEMPRE en la respuesta, también en los errores.
 *
 * Node entrega los headers en minúsculas (`request.headers['x-request-id']`); este es el nombre
 * con el que se escribe en la respuesta y se documenta.
 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Largo máximo de un `X-Request-Id` aceptado. Alcanza para un UUID (36), un ULID (26), un id de
 * AWS/GCP o un prefijo propio más un UUID, sin dejar que un cliente meta kilobytes que después
 * viajarían a cada log y proceso posterior.
 */
export const REQUEST_ID_MAX_LENGTH = 128;

/**
 * Formato de un `X-Request-Id` aceptado: letras ASCII, dígitos y `-`, `_`, `.`, `:`, de 1 a
 * `REQUEST_ID_MAX_LENGTH` caracteres.
 *
 * Sin espacios, comas, comillas ni caracteres de control: el valor va a la respuesta y, más
 * adelante, a los logs, así que no debe poder partir una línea de log ni inyectar otro campo. Un
 * header repetido llega unido con `", "` y por eso tampoco pasa: se genera uno nuevo.
 */
export const REQUEST_ID_PATTERN = new RegExp(
  `^[A-Za-z0-9._:-]{1,${REQUEST_ID_MAX_LENGTH}}$`,
);

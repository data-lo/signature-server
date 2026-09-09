/**
 * Las cuatro maneras de mirar la MISMA bandeja.
 *
 * Sustituye a las tres pantallas segmentadas ("Por firmar", "Enviados para firma",
 * "Completados"), que eran tres rutas distintas del frontend pidiéndole al mismo endpoint
 * combinaciones de `participantEmail`/`email`/`status`. El problema no era la duplicación sino
 * que la regla vivía en el cliente: cada pantalla armaba su consulta a mano, así que "qué
 * significa que un documento me toque a mí" se contestaba distinto según quién preguntara —y
 * ninguna de las tres podía combinarse con las demás.
 *
 * Ahora el criterio es del servidor y `view` sólo lo nombra. No cambia QUÉ documentos puede ver
 * el usuario —eso lo decide el acceso, que se aplica siempre— sino cuáles de esos se listan.
 */
export enum DOCUMENT_VIEW_ENUM {
  /**
   * Lo que espera algo de mí: soy participante, mi respuesta sigue pendiente y el documento
   * sigue abierto. Es la vista por defecto porque es la única que implica una tarea.
   *
   * NO exige que sea mi turno en el orden de firma. Cubre "firma o revisión" —el rol no se
   * distingue acá— y equivale a la sección "Por firmar" tal como se comportaba por defecto.
   */
  REQUIRES_MY_SIGNATURE = 'requires_my_signature',

  /**
   * Los que YO mandé a firmar (`documents.created_by`), sin importar en qué estado estén.
   *
   * Ojo: la sección "Enviados para firma" pedía `email=<mi correo>`, que el backend traducía a
   * "creados por mí O donde participo" — así que colaba en esa lista documentos ajenos donde yo
   * sólo firmaba. Acá significa lo que dice: creados por mí.
   */
  CREATED_BY_ME = 'created_by_me',

  /** Los que ya terminaron su flujo de firma, participe yo o los haya creado. */
  COMPLETED = 'completed',

  /** Todo lo que puedo ver, sin recorte: el punto de partida de una búsqueda libre. */
  ALL = 'all',
}

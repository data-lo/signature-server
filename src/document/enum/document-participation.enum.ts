/**
 * Qué papel juega el usuario que consulta en cada documento del listado.
 *
 * Existe porque el listado dejó de estar segmentado: cuando había tres secciones, la sección
 * misma contestaba esta pregunta —lo que aparecía en "Por firmar" requería mi firma y punto— y
 * bastaba con no preguntarla. En una sola lista mezclada, cada fila tiene que decir por qué está
 * ahí, y esa es la columna "Participación".
 *
 * Es un valor DERIVADO, no una columna: sale de comparar al usuario con los colaboradores del
 * documento en cada consulta. Dos personas viendo el mismo documento reciben valores distintos, y
 * el de una misma persona cambia en cuanto firma.
 */
export enum DOCUMENT_PARTICIPATION_ENUM {
  /** Me toca actuar: soy firmante o revisor, no he respondido y el documento sigue abierto. */
  REQUIRES_MY_SIGNATURE = 'requires_my_signature',

  /** Lo mandé yo a firmar y ya no espera nada de mí. */
  CREATED_BY_ME = 'created_by_me',

  /**
   * Estoy dentro sin que se me pida nada ahora mismo: ya firmé, sólo observo, o el documento
   * cerró. Es el valor de reposo — lo que queda cuando ninguno de los otros dos aplica.
   */
  PARTICIPANT = 'participant',
}

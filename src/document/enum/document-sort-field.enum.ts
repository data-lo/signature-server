/**
 * Los únicos campos por los que el listado se deja ordenar.
 *
 * Es un enum y no el nombre de la columna que mande el cliente: `ORDER BY` no admite parámetros
 * preparados —el ordenamiento se interpola en el SQL— así que aceptar una cadena libre sería
 * abrirle la puerta a una inyección por la única vía que el resto de la consulta ya cierra. Con
 * el enum, lo que llega se valida contra una lista cerrada antes de tocar el query builder, y lo
 * que se interpola sale de un mapa nuestro, no del parámetro.
 */
export enum DOCUMENT_SORT_FIELD_ENUM {
  CREATED_AT = 'createdAt',
  SIGNED_AT = 'signedAt',
  FILE_NAME = 'fileName',
  STATUS = 'status',
}

/** Dirección del ordenamiento; en mayúsculas porque es lo que espera TypeORM. */
export enum SORT_DIRECTION_ENUM {
  ASC = 'ASC',
  DESC = 'DESC',
}

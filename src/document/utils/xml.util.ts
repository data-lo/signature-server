/**
 * Escapa el texto que va dentro de un nodo o atributo XML.
 *
 * Vive aquí y no dentro de un artefacto concreto porque lo comparten las dos piezas de evidencia
 * que el backend serializa a XML —la cadena canónica del sello (`seal-artifacts.ts`) y el XML de
 * auditoría (`audit-xml/`)—, y las dos escapan por la misma razón: su contenido viene de datos
 * de negocio (nombres, correos, certificados) que pueden traer cualquier carácter, y un `&` o un
 * `<` sueltos producen un archivo que no abre.
 *
 * Se escapan los cuatro caracteres que rompen un documento XML en texto o en atributo. `'` no se
 * escapa a propósito: los atributos que emitimos van entre comillas dobles, así que el apóstrofo
 * es literal válido, y esta función se comparte con la cadena canónica —la preimagen del hash
 * sellado—, donde cambiar el escapado cambiaría los bytes de evidencia ya emitida.
 */
export function escapeXml(value: string | null | undefined): string {
  // Total a propósito: un atributo sin valor no puede tumbar la descarga de la evidencia, que es
  // lo único que el usuario vino a buscar.
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

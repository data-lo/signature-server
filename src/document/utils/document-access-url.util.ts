/**
 * Construye los enlaces que viajan en los correos de firma.
 *
 * Todo enlace a un documento apunta a `/access-document` y NUNCA directo a `/documents/:id` ni a
 * `/dashboard/documents/:id`. Quien recibe el correo casi siempre lo abre sin sesión:
 * `/documents/:id` redirige 308 a `/dashboard/documents/:id` y de ahí, sin cookie `token`, a
 * `/login`, perdiendo qué documento se quería abrir. `/access-document` guarda el contexto
 * —documentId, collaboratorId, email— antes de mandar a `/login`, vincula la cuenta al colaborador y
 * devuelve al usuario al documento correcto.
 */

// La base del frontend se resuelve en `shared/utils/frontend-url.util`: la misma normalización la
// necesitan Stripe, las invitaciones a organización y el origin de CORS, no solo estos enlaces.
import { frontendBaseUrl } from 'src/shared/utils/frontend-url.util';

/** Enlace al documento para un colaborador concreto (punto de entrada `/access-document`). */
export function buildDocumentAccessUrl(
  documentId: string,
  collaboratorId: string,
  email: string,
): string {
  const query = new URLSearchParams({
    docId: documentId,
    collabId: collaboratorId,
    email,
  });
  return `${frontendBaseUrl()}/access-document?${query.toString()}`;
}

/** Enlace al listado de documentos, ya bajo `/dashboard` para evitar el redirect 308 heredado. */
export function buildAllDocumentsUrl(): string {
  return `${frontendBaseUrl()}/dashboard/documents`;
}

/**
 * Construye el enlace a la vista pública del documento firmado, sin sesión. Es lo que se codifica en
 * el QR de la hoja de información de firmas: quien reciba el PDF impreso o reenviado puede
 * escanearlo y llegar a la verificación en línea sin tener cuenta.
 */
export function buildPublicDocumentUrl(documentId: string): string {
  return `${frontendBaseUrl()}/public/documents/${documentId}`;
}

/**
 * Nombre del parámetro que señala de qué firma vino el QR escaneado.
 *
 * Es el id del colaborador, que ya es el identificador con el que la vista pública publica a cada
 * firmante (`PublicSigner.id`). No hace falta un token aparte: el parámetro no CONCEDE acceso a
 * nada —la vista pública ya es consultable sin sesión y decide por su cuenta qué publica—, sólo
 * dice a quién resaltar. Un token añadiría un secreto que gestionar y caducar sin proteger nada
 * que no estuviera ya publicado.
 */
export const ADVANCED_SIGNATURE_QUERY_PARAM = 'firma';

/**
 * Construye el enlace del QR que se estampa junto a una firma avanzada.
 *
 * **Apunta a la vista pública del DOCUMENTO, con la firma señalada por query.** La pantalla anterior
 * mostraba esa firma sola y fuera del documento al que pertenece, así que quien escaneaba veía una
 * constancia suelta y tenía que navegar aparte; ahora cae en la verificación completa —el PDF, el
 * sello, todos los firmantes— con el suyo resaltado.
 *
 * Esa pantalla propia NO se elimina: los QR ya estampados viven dentro de PDFs que no se regeneran,
 * así que su URL tiene que seguir resolviendo para siempre.
 *
 * Lleva el id del colaborador y no sólo el del documento, porque cada firmante tiene su propio QR.
 */
export function buildAdvancedSignatureUrl(
  documentId: string,
  collaboratorId: string,
): string {
  const query = new URLSearchParams({
    [ADVANCED_SIGNATURE_QUERY_PARAM]: collaboratorId,
  });

  return `${buildPublicDocumentUrl(documentId)}?${query.toString()}`;
}

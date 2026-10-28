/**
 * Construcción de los enlaces que viajan en los correos de firma.
 *
 * Todo enlace a un documento debe apuntar a `/access-document`, NUNCA directo a
 * `/documents/:id` ni a `/dashboard/documents/:id`. El destinatario de un correo casi siempre
 * abre el link en un navegador sin sesión: `/documents/:id` lo manda al middleware del frontend,
 * que redirige 308 a `/dashboard/documents/:id`, y de ahí — al no haber cookie `token` — a
 * `/login`, perdiendo por completo qué documento se quería abrir (tras el login se cae al
 * `/dashboard/documents/create` por defecto). `/access-document` es el punto de entrada diseñado
 * para esto: guarda el contexto (documentId, collaboratorId, email) antes de mandar a `/login`,
 * vincula la cuenta al colaborador y devuelve al usuario al documento correcto.
 */

// La base del frontend se resuelve en `common/utils/frontend-url.util`: la misma normalización la
// necesitan Stripe, las invitaciones a organización y el origin de CORS, no solo estos enlaces.
import {
  frontendBaseUrl,
  publicWebAppBaseUrl,
} from 'src/common/utils/frontend-url.util';

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

/**
 * Enlace a la vista pública del documento firmado (sin sesión). Es lo que se codifica en el QR de
 * la hoja de información de firmas: quien reciba el PDF impreso o reenviado puede escanearlo y
 * llegar a la verificación en línea sin tener cuenta.
 *
 * Es también la URL pública de consulta que devuelve la API de integración al crear un documento.
 * Usa `publicWebAppBaseUrl()` (`PUBLIC_WEB_APP_URL`, o `FRONTEND_URL` si falta).
 */
export function buildPublicDocumentUrl(documentId: string): string {
  return `${publicWebAppBaseUrl()}/public/documents/${documentId}`;
}

/**
 * Enlace de la invitación individual de un firmante: la pantalla pública `/sign/:token`.
 *
 * Lleva sólo el token, nunca el id del documento ni del colaborador: quien tenga el enlace no
 * aprende de él nada del documento, y el backend lo resuelve con `GetSigningSessionUseCase`.
 *
 * @param token - Token de la invitación, tal como lo emitió `SigningInvitationService.issue`.
 * @returns `${PUBLIC_WEB_APP_URL}/sign/<token>`.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * buildSigningInvitationUrl('q3Vb…'); // 'https://app.firmalo.mx/sign/q3Vb…'
 * ```
 */
export function buildSigningInvitationUrl(token: string): string {
  return `${publicWebAppBaseUrl()}/sign/${encodeURIComponent(token)}`;
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
 * Enlace del QR que se estampa junto a una firma avanzada.
 *
 * **Apunta a la vista pública del DOCUMENTO, con la firma señalada por query.** Antes apuntaba a
 * `/public/documents/:id/signatures/:collaboratorId`, una pantalla propia que mostraba esa firma
 * sola y fuera del documento al que pertenece; quien escaneaba el código veía una constancia
 * suelta y tenía que navegar aparte para ver el documento. Ahora cae en la verificación completa
 * —el PDF, el sello, todos los firmantes— con el suyo resaltado.
 *
 * Esa pantalla propia NO se elimina: los QR ya estampados viven dentro de PDFs que no se
 * regeneran, así que su URL tiene que seguir resolviendo para siempre.
 *
 * Lleva el id del colaborador y no sólo el del documento: cada firmante tiene su propio QR, así
 * que dos firmas avanzadas del mismo documento nunca codifican la misma URL.
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

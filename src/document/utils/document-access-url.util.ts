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
 * Enlace a la vista pública del documento firmado (sin sesión). Es lo que se codifica en el QR de
 * la hoja de información de firmas: quien reciba el PDF impreso o reenviado puede escanearlo y
 * llegar a la verificación en línea sin tener cuenta.
 */
export function buildPublicDocumentUrl(documentId: string): string {
  return `${frontendBaseUrl()}/public/documents/${documentId}`;
}

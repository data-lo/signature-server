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

/**
 * Mismo fallback que `.env.example` y que el resto del backend. Deliberadamente NO se usa un
 * host interno de Docker (`http://frontend:3000`): estas URLs se abren desde el cliente de
 * correo del destinatario, donde un hostname de red interna es irresoluble y el enlace queda
 * muerto aunque el correo se haya enviado bien.
 */
const DEFAULT_FRONTEND_URL = 'http://localhost:3001';

/** Base del frontend sin diagonales finales, para no generar URLs con `//`. */
export function frontendBaseUrl(): string {
  const configured = process.env.FRONTEND_URL?.trim();
  return (configured || DEFAULT_FRONTEND_URL).replace(/\/+$/, '');
}

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

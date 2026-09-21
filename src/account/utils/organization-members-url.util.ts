// La base del frontend se resuelve en `common/utils/frontend-url.util`: la misma normalización la
// necesitan Stripe, los enlaces de firma y el origin de CORS, no sólo éste.
import { frontendBaseUrl } from 'src/common/utils/frontend-url.util';

/**
 * Enlace a la pantalla de miembros de una organización.
 *
 * Apunta ya bajo `/dashboard` y no a `/organizations/:id/members`: quien abre el enlace desde un
 * correo llega sin sesión, y la ruta corta pasa por el middleware del frontend, que redirige a
 * `/login` perdiendo por el camino a qué organización se quería entrar. Mismo criterio que
 * `buildAllDocumentsUrl`.
 *
 * @param organizationId - Organización cuya lista de miembros se quiere abrir.
 * @returns La URL absoluta de la sección de miembros.
 *
 * @example
 * ```ts
 * buildOrganizationMembersUrl('org-1');
 * // 'http://localhost:3001/dashboard/organizations/org-1/members'
 * ```
 */
export function buildOrganizationMembersUrl(organizationId: string): string {
  return `${frontendBaseUrl()}/dashboard/organizations/${organizationId}/members`;
}

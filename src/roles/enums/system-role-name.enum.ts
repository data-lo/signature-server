/**
 * Roles de sistema: los que no pertenecen a ninguna organización (`organization_id` NULL) y
 * vienen sembrados de fábrica, a diferencia de los roles custom que crea cada organización.
 *
 * - `OWNER`: quien crea la cuenta. Es el rol que se asigna solo, al registrarse o al dar de alta
 *   una organización; nadie lo otorga a mano. Trae el catálogo estático completo, y es el único
 *   con `MEMBER.REMOVE` (dar de baja a alguien de la organización) — ver
 *   `STATIC_ROLE_PERMISSION_MATRIX`.
 * - `ADMIN`: administrador nombrado por el propietario, asignable a un miembro desde la pantalla
 *   de miembros. Todo el catálogo de negocio menos dar de baja miembros.
 * - `MEMBER`: miembro raso — crear, ver y firmar sus documentos. Es el rol predeterminado al
 *   dar de alta o invitar a alguien nuevo.
 * - `INTEGRATION_DOCUMENT_CREATOR`: el rol mínimo de un creador que la API de integración dio de
 *   alta en la organización al recibir un documento a su nombre (ver `IntegrationCreatorService`).
 *   Sólo crear y ver sus propios documentos; un administrador puede cambiárselo después.
 */
export enum SYSTEM_ROLE_NAME_ENUM {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
  INTEGRATION_DOCUMENT_CREATOR = 'INTEGRATION_DOCUMENT_CREATOR',
}

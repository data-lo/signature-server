/**
 * Roles de sistema: los que no pertenecen a ninguna organización (`organization_id` NULL) y
 * vienen sembrados de fábrica, a diferencia de los roles custom que crea cada organización.
 *
 * - `OWNER`: quien crea la cuenta. Es el rol que se asigna solo, al registrarse o al dar de alta
 *   una organización; nadie lo otorga a mano.
 * - `ADMIN`: administrador nombrado por el propietario. Mismos permisos que OWNER hoy, pero
 *   asignable a un miembro desde la pantalla de miembros.
 * - `MEMBER`: miembro raso — crear, ver y firmar sus documentos.
 */
export enum SYSTEM_ROLE_NAME_ENUM {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
}

/**
 * Roles de sistema: los que no pertenecen a ninguna organización (`organization_id` NULL) y
 * vienen sembrados de fábrica, a diferencia de los roles custom que crea cada organización.
 *
 * - `OWNER`: quien crea la cuenta. Es el rol que se asigna solo, al registrarse o al dar de alta
 *   una organización; nadie lo otorga a mano. Es el único que trae `MEMBER.DELETE` (dar de baja
 *   a alguien de la organización) — ver `STATIC_ROLE_PERMISSION_MATRIX`.
 * - `ADMIN`: administrador nombrado por el propietario, asignable a un miembro desde la pantalla
 *   de miembros. Todo el catálogo de negocio menos dar de baja miembros.
 * - `MEMBER`: miembro raso — crear, ver y firmar sus documentos. Es el rol predeterminado al
 *   dar de alta o invitar a alguien nuevo.
 */
export enum SYSTEM_ROLE_NAME_ENUM {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
}

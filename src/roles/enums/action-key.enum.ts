export enum ACTION_KEY_ENUM {
  CREATE = 'CREATE',
  READ = 'READ',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  /**
   * Acciones de negocio que estrena el catálogo estático de permisos
   * (`src/roles/static-permission-catalog.ts`). Son verbos propios del dominio, no del CRUD:
   * un firmante puede SIGN sin poder UPDATE, y un aprobador puede APPROVE sin poder DELETE.
   */
  SEND_SIGNATURE_REQUEST = 'SEND_SIGNATURE_REQUEST',
  SIGN = 'SIGN',
  APPROVE = 'APPROVE',
  INVITE = 'INVITE',
  /**
   * Verbos que estrena la ampliación del catálogo.
   *
   * `MANAGE` es "administrar por completo" (contratar, cambiar o cancelar el plan; crear o editar
   * roles) y no se descompone en CREATE/UPDATE/DELETE porque el catálogo lo concede entero.
   * `REMOVE` es dar de baja una membresía: sustituye a `DELETE` sobre MEMBER, que era el verbo
   * genérico del CRUD. `CANCEL` es cancelar un documento, que no es borrarlo.
   */
  MANAGE = 'MANAGE',
  REMOVE = 'REMOVE',
  CANCEL = 'CANCEL',
}

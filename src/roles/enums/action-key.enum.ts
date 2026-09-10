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
}

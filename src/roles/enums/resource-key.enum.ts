export enum RESOURCE_KEY_ENUM {
  DOCUMENT = 'DOCUMENT',
  ORGANIZATION = 'ORGANIZATION',
  USER = 'USER',
  /** Miembros de una organización; lo estrenó el catálogo estático (MEMBER.INVITE). */
  MEMBER = 'MEMBER',
  /**
   * Recursos que estrena la ampliación del catálogo estático
   * (`src/roles/static-permission-catalog.ts`): el plan y los pagos de la organización, y sus
   * roles. Van aparte de ORGANIZATION porque se conceden por separado — un administrador puede
   * editar los datos de la organización sin poder cambiarle el plan.
   */
  BILLING = 'BILLING',
  ROLE = 'ROLE',
}

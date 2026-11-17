/** Si un endpoint recibe entregas nuevas (`webhook_endpoints.status`). */
export enum WEBHOOK_ENDPOINT_STATUS_ENUM {
  /** Se registran entregas para los eventos suscritos. */
  ACTIVE = 'ACTIVE',
  /**
   * No se registran entregas nuevas. Las ya registradas se procesan con su snapshot de URL y
   * secreto; desactivar no las cancela. Lleva `disabled_at`.
   */
  DISABLED = 'DISABLED',
}

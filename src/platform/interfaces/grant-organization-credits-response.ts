/** Lo que devuelve `POST /api/v1/platform/organizations/:organizationId/credits`. */
export interface OrganizationCreditGrantData {
  /** La recarga (`platform_credit_grants.id`). */
  grantId: string;

  organizationId: string;

  billingProfileId: string;

  /** El lote `ADD_ON` creado por la recarga. */
  creditLotId: string;

  /** Documentos que acreditó esta recarga. */
  documentsGranted: number;

  /** Saldo utilizable ahora mismo; en una repetición, lo que quede tras el uso. */
  creditsAvailable: number;

  externalReference: string;

  /** `true` si la respuesta es la repetición de una recarga ya confirmada. */
  replayed: boolean;
}

import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';

/** Lo que devuelve `POST /api/v1/internal/organizations/provision`. */
export interface ProvisionedEnterpriseAccountData {
  /** Organización creada (`organizations.id`). */
  organizationId: string;

  /** Membresía OWNER del propietario en la organización (`accounts.id`, tipo ORGANIZATION). */
  organizationAccountId: string;

  /** Usuario propietario (`users.id`). */
  ownerUserId: string;

  /** Cuenta PERSONAL del propietario (`accounts.id`, tipo PERSONAL). */
  ownerAccountId: string;

  /** Siempre `PROVISIONED`: el propietario no tiene contraseña ni CURP. */
  ownerLifecycleStatus: USER_LIFECYCLE_STATUS_ENUM;

  /** Rol de sistema del propietario en la organización: `OWNER`. */
  ownerRole: string;

  /** Perfil de facturación de la organización. */
  billingProfileId: string;

  /** `enterprise`. */
  planType: string;

  /** Documentos acreditados por el periodo manual. */
  documentsGranted: number;

  /** Saldo utilizable ahora mismo; en una repetición, lo que quede tras el uso. */
  creditsAvailable: number;

  apiKeyId: string;

  /** `fma_live_<publicId>`: reconoce la llave sin exponer el secreto. */
  apiKeyPrefix: string;

  /**
   * La llave completa `fma_live_<publicId>_<secret>`, sólo en la respuesta que la emitió. En una
   * repetición con el mismo `Idempotency-Key` es `null`: el secreto no se guarda en claro.
   */
  apiKey: string | null;

  /** `true` si la respuesta es la repetición de un aprovisionamiento ya confirmado. */
  replayed: boolean;
}

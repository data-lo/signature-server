import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';

/**
 * Lo que un plan HABILITA, nombrado por la acción y no por el plan.
 *
 * El valor del enum es además la llave con la que la acción viaja en la respuesta, y eso no es
 * una comodidad de serialización: obliga a que el identificador con el que el backend autoriza
 * (`PLAN_ACTION_ENUM.BULK_SIGNING`) y el que el frontend lee (`actions.bulkSigning`) sean
 * literalmente el mismo símbolo. Con dos listas paralelas —una constante acá y un string allá—
 * renombrar una acción dejaría al frontend leyendo `undefined`, que en un booleano se lee como
 * "no puede" y esconde el fallo detrás de un bloqueo plausible.
 *
 * **Describen capacidad comercial, no permiso de uso.** `GRAPH_SIGNATURE_BIOMETRICS` está en
 * todos los planes y aun así cada firma biométrica se cobra aparte: la acción dice que el plan
 * la contempla, y los créditos dicen si se puede ejecutar HOY. Son dos preguntas distintas y el
 * caso de uso que autoriza tiene que hacer las dos.
 */
export enum PLAN_ACTION_ENUM {
  SIGN_SIMPLE_AND_ADVANCED = 'signSimpleAndAdvanced',
  SIGN_IN_ORDER = 'signInOrder',
  UNLIMITED_SIGNERS = 'unlimitedSigners',
  REQUEST_WITNESSES = 'requestWitnesses',
  INTELLIGENT_SEARCH = 'intelligentSearch',
  GRAPH_SIGNATURE_BIOMETRICS = 'graphSignatureBiometrics',
  BULK_SIGNING = 'bulkSigning',
  ORGANIZATION_ACCOUNT = 'organizationAccount',
  PRE_APPROVAL = 'preApproval',
  MIX_SIGNATURE_TYPES = 'mixSignatureTypes',
  PRIORITY_SUPPORT = 'prioritySupport',
  CUSTOM_BRANDING = 'customBranding',
  API_INTEGRATION = 'apiIntegration',
  CASE_FILE_GROUPING = 'caseFileGrouping',
  BUY_DOCUMENT_CREDITS = 'buyDocumentCredits',
}

/**
 * Los topes numéricos del plan.
 *
 * Sólo dos, y no por falta de candidatos: un límite entra acá cuando el plan es quien lo decide.
 * El precio del documento extra, por ejemplo, NO está —depende de `catalog_prices` vía
 * `eligible_plan_type`, cambia sin desplegar y tiene vigencias— y duplicarlo en este mapa
 * garantizaría que algún día el importe que se cobra y el que se anuncia dejaran de coincidir.
 */
export enum PLAN_LIMIT_ENUM {
  DOCUMENTS_INCLUDED_PER_PERIOD = 'documentsIncludedPerPeriod',
  MAX_ORGANIZATION_MEMBERS = 'maxOrganizationMembers',
}

export type PlanActions = Record<PLAN_ACTION_ENUM, boolean>;

/**
 * `null` significa **"no lo fija el plan"**, y cubre a propósito dos casos que para el consumidor
 * se resuelven igual: el tope que se negocia por contrato (`enterprise`, `partners`) y el que no
 * tiene techo. Los dos se dibujan como "sin límite en esta pantalla" y los dos obligan a que
 * quien necesite el número real lo pida a su fuente en vez de deducirlo de acá. `0` es distinto y
 * sí es una respuesta: el plan lo prohíbe.
 */
export type PlanLimits = Record<PLAN_LIMIT_ENUM, number | null>;

export interface PlanEntitlements {
  actions: PlanActions;
  limits: PlanLimits;
}

/**
 * Estado comercial completo de la cuenta activa: lo que se contrató, lo que queda y lo que se
 * puede hacer con ello.
 *
 * Es una sola respuesta porque las tres cosas se leen siempre juntas y por separado se
 * contradicen: un plan `premium` con el saldo agotado habilita la firma por lotes y no habilita
 * crear el documento, y una pantalla que sólo tuviera el plan dibujaría un botón que el backend
 * va a rechazar.
 */
export interface BillingAccessResponse {
  billingProfileId: string | null;
  hasActiveSubscription: boolean;
  currentPlanType: string | null;
  status: BILLING_PROFILE_STATUS_ENUM | null;
  /**
   * Por dónde entró el dinero del ÚLTIMO periodo facturado, no del perfil: la columna vive en
   * `subscription_billing_history` y no en `billing_profiles` (ver `BILLING_SOURCE_ENUM`), así
   * que un perfil sin periodos cobrados —una cuenta gratuita— responde `null`, que es la verdad:
   * todavía no lo cobró nadie.
   */
  billingSource: BILLING_SOURCE_ENUM | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  /** Documentos que la cuenta puede consumir HOY, sumando todos sus lotes vigentes. */
  creditsAvailable: number;
  actions: PlanActions;
  limits: PlanLimits;
}

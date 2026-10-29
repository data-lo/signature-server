import { FREE_PLAN_TYPE } from '../catalog/free-plan.constants';
import {
  PLAN_ACTION_ENUM,
  PLAN_LIMIT_ENUM,
  type PlanEntitlements,
} from './plan-entitlements.types';

/**
 * Qué habilita cada plan. **Es la tabla comercial, escrita en código.**
 *
 * Vive acá y no en la base de datos porque hoy no es un dato: es una decisión de producto que
 * cambia con una release, se revisa en el diff junto al código que la lee y no tiene por qué
 * sobrevivir a un despliegue con un valor distinto del que el código espera. Una tabla de
 * beneficios por plan exigiría migración, alta de cada plan nuevo y un estado intermedio —el
 * plan sincronizado desde Stripe cuyos beneficios nadie dio de alta todavía— en el que la
 * aplicación no sabría qué contestar. Cuando los beneficios se vendan por contrato y cambien sin
 * desplegar, la tabla tendrá sentido; hasta entonces sería una indirección que sólo puede
 * desincronizarse.
 *
 * **Se escribe cada acción en cada plan, sin herencia entre niveles.** Sale más largo que
 * derivar `premium` de `plus` más un delta, y es a propósito: los planes no son una escalera
 * —`partners` y `enterprise` comparten beneficios sin que uno sea "más" que el otro— y una
 * jerarquía obligaría a leer tres definiciones para saber si un plan permite algo. Acá la
 * respuesta a "¿qué incluye premium?" es una sola columna, y activar un beneficio es cambiar un
 * `false` por un `true` en el renglón que se está mirando.
 *
 * Lo que NO está acá, y no por olvido:
 *
 * - **El precio del documento extra.** Sale de `catalog_prices` filtrando por
 *   `eligible_plan_type` (free $39, plus $32, premium $24, enterprise/partners negociado).
 *   Tiene vigencias, versiones y se edita sin desplegar; copiarlo acá garantizaría que algún día
 *   se cobre uno y se anuncie otro.
 * - **Los documentos de bienvenida del plan gratuito** (3, una sola vez). No son un límite por
 *   periodo sino una concesión única, y quien la otorga es el flujo que emite `credit_lots`, no
 *   esta configuración.
 * - **Los créditos biométricos.** `GRAPH_SIGNATURE_BIOMETRICS` dice que el plan contempla la
 *   firma con biometría; cuántas quedan es saldo, y el saldo no es un beneficio del plan.
 */
export const PLAN_ENTITLEMENTS = {
  free: {
    actions: {
      [PLAN_ACTION_ENUM.SIGN_SIMPLE_AND_ADVANCED]: true,
      [PLAN_ACTION_ENUM.SIGN_IN_ORDER]: true,
      [PLAN_ACTION_ENUM.UNLIMITED_SIGNERS]: true,
      [PLAN_ACTION_ENUM.REQUEST_WITNESSES]: true,
      [PLAN_ACTION_ENUM.INTELLIGENT_SEARCH]: true,
      [PLAN_ACTION_ENUM.GRAPH_SIGNATURE_BIOMETRICS]: true,
      [PLAN_ACTION_ENUM.BULK_SIGNING]: false,
      [PLAN_ACTION_ENUM.ORGANIZATION_ACCOUNT]: false,
      [PLAN_ACTION_ENUM.PRE_APPROVAL]: false,
      [PLAN_ACTION_ENUM.MIX_SIGNATURE_TYPES]: false,
      [PLAN_ACTION_ENUM.PRIORITY_SUPPORT]: false,
      [PLAN_ACTION_ENUM.CUSTOM_BRANDING]: false,
      [PLAN_ACTION_ENUM.API_INTEGRATION]: false,
      [PLAN_ACTION_ENUM.CASE_FILE_GROUPING]: false,
      /**
       * El plan gratuito SÍ puede comprar documentos sueltos, y es el caso que más lo necesita:
       * es su única forma de firmar una vez agotada la bienvenida. `catalog_prices` tiene su
       * precio con `eligible_plan_type = 'free'` justamente por eso.
       */
      [PLAN_ACTION_ENUM.BUY_DOCUMENT_CREDITS]: true,
    },
    limits: {
      /** Ninguno por periodo: lo que recibe es la concesión única de bienvenida. */
      [PLAN_LIMIT_ENUM.DOCUMENTS_INCLUDED_PER_PERIOD]: 0,
      /** `0` y no `null`: el plan gratuito no tiene cuenta empresarial, así que nadie cabe. */
      [PLAN_LIMIT_ENUM.MAX_ORGANIZATION_MEMBERS]: 0,
    },
  },
  plus: {
    actions: {
      [PLAN_ACTION_ENUM.SIGN_SIMPLE_AND_ADVANCED]: true,
      [PLAN_ACTION_ENUM.SIGN_IN_ORDER]: true,
      [PLAN_ACTION_ENUM.UNLIMITED_SIGNERS]: true,
      [PLAN_ACTION_ENUM.REQUEST_WITNESSES]: true,
      [PLAN_ACTION_ENUM.INTELLIGENT_SEARCH]: true,
      [PLAN_ACTION_ENUM.GRAPH_SIGNATURE_BIOMETRICS]: true,
      [PLAN_ACTION_ENUM.BULK_SIGNING]: true,
      [PLAN_ACTION_ENUM.ORGANIZATION_ACCOUNT]: true,
      [PLAN_ACTION_ENUM.PRE_APPROVAL]: false,
      [PLAN_ACTION_ENUM.MIX_SIGNATURE_TYPES]: false,
      [PLAN_ACTION_ENUM.PRIORITY_SUPPORT]: false,
      [PLAN_ACTION_ENUM.CUSTOM_BRANDING]: false,
      [PLAN_ACTION_ENUM.API_INTEGRATION]: false,
      [PLAN_ACTION_ENUM.CASE_FILE_GROUPING]: false,
      [PLAN_ACTION_ENUM.BUY_DOCUMENT_CREDITS]: true,
    },
    limits: {
      [PLAN_LIMIT_ENUM.DOCUMENTS_INCLUDED_PER_PERIOD]: 25,
      [PLAN_LIMIT_ENUM.MAX_ORGANIZATION_MEMBERS]: null,
    },
  },
  premium: {
    actions: {
      [PLAN_ACTION_ENUM.SIGN_SIMPLE_AND_ADVANCED]: true,
      [PLAN_ACTION_ENUM.SIGN_IN_ORDER]: true,
      [PLAN_ACTION_ENUM.UNLIMITED_SIGNERS]: true,
      [PLAN_ACTION_ENUM.REQUEST_WITNESSES]: true,
      [PLAN_ACTION_ENUM.INTELLIGENT_SEARCH]: true,
      [PLAN_ACTION_ENUM.GRAPH_SIGNATURE_BIOMETRICS]: true,
      [PLAN_ACTION_ENUM.BULK_SIGNING]: true,
      [PLAN_ACTION_ENUM.ORGANIZATION_ACCOUNT]: true,
      [PLAN_ACTION_ENUM.PRE_APPROVAL]: true,
      [PLAN_ACTION_ENUM.MIX_SIGNATURE_TYPES]: true,
      [PLAN_ACTION_ENUM.PRIORITY_SUPPORT]: true,
      [PLAN_ACTION_ENUM.CUSTOM_BRANDING]: false,
      [PLAN_ACTION_ENUM.API_INTEGRATION]: false,
      [PLAN_ACTION_ENUM.CASE_FILE_GROUPING]: false,
      [PLAN_ACTION_ENUM.BUY_DOCUMENT_CREDITS]: true,
    },
    limits: {
      [PLAN_LIMIT_ENUM.DOCUMENTS_INCLUDED_PER_PERIOD]: 60,
      [PLAN_LIMIT_ENUM.MAX_ORGANIZATION_MEMBERS]: null,
    },
  },
  enterprise: {
    actions: {
      [PLAN_ACTION_ENUM.SIGN_SIMPLE_AND_ADVANCED]: true,
      [PLAN_ACTION_ENUM.SIGN_IN_ORDER]: true,
      [PLAN_ACTION_ENUM.UNLIMITED_SIGNERS]: true,
      [PLAN_ACTION_ENUM.REQUEST_WITNESSES]: true,
      [PLAN_ACTION_ENUM.INTELLIGENT_SEARCH]: true,
      [PLAN_ACTION_ENUM.GRAPH_SIGNATURE_BIOMETRICS]: true,
      [PLAN_ACTION_ENUM.BULK_SIGNING]: true,
      [PLAN_ACTION_ENUM.ORGANIZATION_ACCOUNT]: true,
      [PLAN_ACTION_ENUM.PRE_APPROVAL]: true,
      [PLAN_ACTION_ENUM.MIX_SIGNATURE_TYPES]: true,
      [PLAN_ACTION_ENUM.PRIORITY_SUPPORT]: true,
      [PLAN_ACTION_ENUM.CUSTOM_BRANDING]: true,
      [PLAN_ACTION_ENUM.API_INTEGRATION]: true,
      [PLAN_ACTION_ENUM.CASE_FILE_GROUPING]: true,
      [PLAN_ACTION_ENUM.BUY_DOCUMENT_CREDITS]: true,
    },
    limits: {
      /** Se pacta por contrato; el número no lo fija el plan. */
      [PLAN_LIMIT_ENUM.DOCUMENTS_INCLUDED_PER_PERIOD]: null,
      [PLAN_LIMIT_ENUM.MAX_ORGANIZATION_MEMBERS]: null,
    },
  },
  /**
   * Mismos beneficios que `enterprise`, y aun así escrito aparte: no es que `partners` "sea"
   * enterprise, es que hoy coinciden. Son dos acuerdos comerciales distintos —uno se vende, el
   * otro se acuerda con un socio— y compartir la definición haría que tocar uno moviera el otro
   * sin que nadie lo pidiera.
   */
  partners: {
    actions: {
      [PLAN_ACTION_ENUM.SIGN_SIMPLE_AND_ADVANCED]: true,
      [PLAN_ACTION_ENUM.SIGN_IN_ORDER]: true,
      [PLAN_ACTION_ENUM.UNLIMITED_SIGNERS]: true,
      [PLAN_ACTION_ENUM.REQUEST_WITNESSES]: true,
      [PLAN_ACTION_ENUM.INTELLIGENT_SEARCH]: true,
      [PLAN_ACTION_ENUM.GRAPH_SIGNATURE_BIOMETRICS]: true,
      [PLAN_ACTION_ENUM.BULK_SIGNING]: true,
      [PLAN_ACTION_ENUM.ORGANIZATION_ACCOUNT]: true,
      [PLAN_ACTION_ENUM.PRE_APPROVAL]: true,
      [PLAN_ACTION_ENUM.MIX_SIGNATURE_TYPES]: true,
      [PLAN_ACTION_ENUM.PRIORITY_SUPPORT]: true,
      [PLAN_ACTION_ENUM.CUSTOM_BRANDING]: true,
      [PLAN_ACTION_ENUM.API_INTEGRATION]: true,
      [PLAN_ACTION_ENUM.CASE_FILE_GROUPING]: true,
      [PLAN_ACTION_ENUM.BUY_DOCUMENT_CREDITS]: true,
    },
    limits: {
      [PLAN_LIMIT_ENUM.DOCUMENTS_INCLUDED_PER_PERIOD]: null,
      [PLAN_LIMIT_ENUM.MAX_ORGANIZATION_MEMBERS]: null,
    },
  },
} as const satisfies Record<string, PlanEntitlements>;

/**
 * Lo que puede hacer una organización que todavía no contrató ningún plan: nada.
 *
 * **No es el plan gratuito.** Las organizaciones nacen sin `billing_profile` —ni plan Free ni
 * créditos de bienvenida— y tienen que contratar una suscripción para operar; responderles los
 * beneficios de Free les habilitaría firmar y comprar documentos sin haber contratado nada. Por eso
 * todas las acciones van en `false` y los topes en `null`: no hay plan que los fije.
 *
 * Las cuentas personales no pasan por aquí: sin plan siguen respondiendo el gratuito, que es con lo
 * que nacen.
 */
export const NO_PLAN_ENTITLEMENTS: PlanEntitlements = {
  actions: {
    [PLAN_ACTION_ENUM.SIGN_SIMPLE_AND_ADVANCED]: false,
    [PLAN_ACTION_ENUM.SIGN_IN_ORDER]: false,
    [PLAN_ACTION_ENUM.UNLIMITED_SIGNERS]: false,
    [PLAN_ACTION_ENUM.REQUEST_WITNESSES]: false,
    [PLAN_ACTION_ENUM.INTELLIGENT_SEARCH]: false,
    [PLAN_ACTION_ENUM.GRAPH_SIGNATURE_BIOMETRICS]: false,
    [PLAN_ACTION_ENUM.BULK_SIGNING]: false,
    [PLAN_ACTION_ENUM.ORGANIZATION_ACCOUNT]: false,
    [PLAN_ACTION_ENUM.PRE_APPROVAL]: false,
    [PLAN_ACTION_ENUM.MIX_SIGNATURE_TYPES]: false,
    [PLAN_ACTION_ENUM.PRIORITY_SUPPORT]: false,
    [PLAN_ACTION_ENUM.CUSTOM_BRANDING]: false,
    [PLAN_ACTION_ENUM.API_INTEGRATION]: false,
    [PLAN_ACTION_ENUM.CASE_FILE_GROUPING]: false,
    [PLAN_ACTION_ENUM.BUY_DOCUMENT_CREDITS]: false,
  },
  limits: {
    [PLAN_LIMIT_ENUM.DOCUMENTS_INCLUDED_PER_PERIOD]: null,
    [PLAN_LIMIT_ENUM.MAX_ORGANIZATION_MEMBERS]: null,
  },
};

/** Los planes con beneficios definidos. No es el catálogo: `plans` es abierto, esto no. */
export type EntitledPlanType = keyof typeof PLAN_ENTITLEMENTS;

export function isEntitledPlanType(
  planType: string | null,
): planType is EntitledPlanType {
  return planType !== null && planType in PLAN_ENTITLEMENTS;
}

/**
 * Los beneficios del plan, con el gratuito como respuesta a todo lo que no reconoce.
 *
 * **El caso desconocido es real y no defensivo.** `plans.plan_type` se alimenta de Stripe
 * (`CatalogSyncService`), así que dar de alta un producto con un `planType` nuevo —o con una
 * errata— pone en `billing_profiles.current_plan_type` un valor que este mapa no tiene, sin que
 * nadie despliegue nada. Ya hay planes así en la base (`basic`), heredados de antes de esta
 * tabla comercial.
 *
 * Se cae al plan gratuito y no se lanza porque de esto cuelga la pantalla entera: reventar
 * dejaría al cliente sin dashboard por un plan mal escrito en el proveedor, mientras que
 * responder Free le deja trabajar con lo mínimo y pedir el resto. Y se cae a Free y no a
 * "todo permitido" por el motivo obvio: lo que no consta como vendido no se regala.
 */
export function resolvePlanEntitlements(
  planType: string | null,
): PlanEntitlements {
  return isEntitledPlanType(planType)
    ? PLAN_ENTITLEMENTS[planType]
    : PLAN_ENTITLEMENTS[FREE_PLAN_TYPE];
}

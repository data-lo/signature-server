/**
 * Eventos del ciclo de vida de una MEMBRESÍA de organización, hermanos de los de invitación
 * (`ORGANIZATION_INVITATION_KAFKA_TOPICS`) y deliberadamente separados de ellos: una invitación
 * es una intención —puede expirar, reenviarse o no aceptarse nunca—, mientras que esto es el
 * hecho consumado de que alguien quedó dentro. Quien escucha "se unió alguien" no debería tener
 * que filtrar invitaciones que nadie aceptó.
 */
export enum ORGANIZATION_MEMBER_KAFKA_TOPICS {
  JOINED = 'organization.member.joined',
}

/**
 * Sobre de `organization.member.joined`: sólo identificadores, sin nombres ni correos.
 *
 * Mismo criterio que `NotificationEventPayload` — el consumidor resuelve el contenido (quién se
 * unió, cómo se llama la organización, qué rol tiene) a partir de estos ids en el momento de
 * notificar. Acarrear los nombres en el evento los congelaría al instante de la publicación, y
 * un aviso reintentado horas después mostraría datos que ya cambiaron.
 *
 * `eventId`, `occurredAt`, `version` y `actorUserId` los pone la outbox al publicar (ver
 * `OutboxService.flush`), no el productor.
 */
export interface OrganizationMemberJoinedEventPayload {
  /** Id de la fila de `events`; es la llave de deduplicación del consumidor. */
  eventId: string;
  occurredAt: string;
  version: number;
  /** Quien provocó el alta: el propio invitado al aceptar, o el administrador que lo agregó. */
  actorUserId: string | null;
  organizationId: string;
  /** Id de la membresía (fila de `accounts`) que quedó activa. */
  accountId: string;
  memberUserId: string;
  roleId: string | null;
}

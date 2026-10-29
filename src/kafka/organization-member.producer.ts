import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { EventEntity } from 'src/event/entities/event.entity';
import { EVENT_TYPE_ENUM } from 'src/event/enums/event-type.enum';
import { OutboxService } from 'src/event/outbox.service';
import { AccountEntity } from 'src/account/entities/account.entity';

import { ORGANIZATION_MEMBER_KAFKA_TOPICS } from './organization-member.topics';

interface EnqueueJoinedParams {
  /** Membresía que acaba de quedar activa, ya guardada con el manager de la transacción. */
  membership: AccountEntity;
  /** Quien provocó el alta: el propio invitado al aceptar, o el administrador que lo agregó. */
  actorUserId: string | null;
}

/**
 * Publica `organization.member.joined` — el hecho de que una persona quedó como miembro ACTIVO
 * de una organización (historia "Notificar a propietarios y administradores cuando un usuario se
 * une a una organización").
 *
 * Va por la outbox y no por el camino directo de `OrganizationInvitationEventsProducer`, y la
 * razón es la misma que en el flujo de aprobación: el evento acompaña una escritura de estado
 * —la fila de `accounts` que queda activa— y anunciarlo antes de que la transacción confirme
 * sería anunciar una incorporación que todavía puede deshacerse. Eso es exactamente lo que pide
 * la historia al excluir del aviso las incorporaciones fallidas.
 *
 * La contrapartida de la outbox es entrega *al menos una vez*, así que el consumidor deduplica
 * por `eventId` (ver `OrganizationMemberEventsConsumer`); las dos piezas son una sola decisión.
 */
@Injectable()
export class OrganizationMemberEventsProducer {
  constructor(private readonly outboxService: OutboxService) {}

  /**
   * Registra en la outbox que una persona quedó como miembro activo, dentro de la transacción
   * del llamador.
   *
   * Lo llaman los cuatro caminos por los que una membresía se vuelve activa —aceptar una
   * invitación, el alta directa desde la pantalla de miembros, el alta administrativa por
   * `userId` y la reactivación de quien había sido dado de baja—, porque para quien administra
   * la organización los cuatro son el mismo hecho: hoy hay alguien dentro que ayer no estaba.
   *
   * @param manager - `EntityManager` de la transacción que deja la membresía activa. Obligatorio
   *   a propósito: fuera de una transacción el evento perdería la garantía por la que existe.
   * @param params - La membresía ya guardada y quién provocó el alta.
   * @returns La fila de `events` registrada; su `id` es el `eventId` del sobre.
   *
   * @throws {QueryFailedError} Si la inserción falla; propaga y revierte la transacción del
   *   llamador, que es lo correcto: sin evento registrado, la incorporación no debe confirmarse.
   *
   * @example
   * ```ts
   * await this.dataSource.transaction(async (manager) => {
   *   const membership = await accountMemberService.saveMembership(dto, user, manager);
   *   await producer.enqueueJoined(manager, { membership, actorUserId: callerId });
   * });
   * await producer.flushOutbox();
   * ```
   */
  async enqueueJoined(
    manager: EntityManager,
    { membership, actorUserId }: EnqueueJoinedParams,
  ): Promise<EventEntity> {
    return this.outboxService.enqueue(manager, {
      eventType: EVENT_TYPE_ENUM.ORGANIZATION_MEMBER_JOINED,
      topic: ORGANIZATION_MEMBER_KAFKA_TOPICS.JOINED,
      body: {
        organizationId: membership.organizationId,
        accountId: membership.id,
        memberUserId: membership.userId,
        roleId: membership.roleId ?? null,
      },
      from: actorUserId,
    });
  }

  /**
   * Publica lo que la outbox tenga pendiente. Se llama DESPUÉS de confirmar la transacción.
   *
   * @returns Nada: es best-effort. Lo que no se consiga publicar se queda con `published_at` en
   *   NULL y lo reintenta el siguiente `flush`, así que un Kafka caído nunca devuelve un error a
   *   quien acaba de unirse a la organización.
   *
   * @example
   * ```ts
   * await producer.flushOutbox();
   * ```
   */
  async flushOutbox(): Promise<void> {
    await this.outboxService.flush();
  }
}

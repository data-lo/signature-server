import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import { NotifyOrganizationAdminsOfNewMemberUseCase } from './applications/notify-organization-admins-of-new-member.use-case';
import {
  ORGANIZATION_MEMBER_KAFKA_TOPICS,
  OrganizationMemberJoinedEventPayload,
} from './organization-member.topics';

/**
 * Adaptador de Kafka de los eventos de membresía: delega en el caso de uso que avisa a
 * propietarios y administradores.
 *
 * Vive en su propio `@Controller` y no dentro de `OrganizationInvitationEventsConsumer` porque
 * son tópicos distintos; la restricción de NestJS es un handler por PATRÓN, no un controller por
 * módulo, así que no hay riesgo de que uno pise al otro.
 *
 * A diferencia de los demás consumidores, aquí NO se reclama el evento entero: la marca de
 * idempotencia se toma por destinatario dentro del caso de uso (ver
 * `NotifyOrganizationAdminsOfNewMemberUseCase`), que es lo que permite reintentar un correo
 * fallido sin repetirles el aviso a los administradores a quienes ya les llegó.
 */
@Controller()
export class OrganizationMemberEventsConsumer {
  constructor(
    private readonly notifyOrganizationAdminsOfNewMember: NotifyOrganizationAdminsOfNewMemberUseCase,
  ) {}

  @EventPattern(ORGANIZATION_MEMBER_KAFKA_TOPICS.JOINED)
  async handleJoined(
    @Payload() payload: OrganizationMemberJoinedEventPayload,
  ): Promise<void> {
    await this.notifyOrganizationAdminsOfNewMember.execute(payload);
  }
}

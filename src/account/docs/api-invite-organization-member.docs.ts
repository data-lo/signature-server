import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { InviteMemberDto } from '../dto/invite-member.dto';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

/** `POST /api/v1/organizations/invite` — invitación a la organización activa. */
export function ApiInviteOrganizationMember() {
  return applyDecorators(
    ApiOperation({
      summary: 'Invitar a un nuevo miembro a la organización activa',
      description:
        'Valida el payload y que el llamador sea ADMIN de la organización activa (X-Account-Id), persiste la invitación (PENDING) con un token único y publica el evento organization.member.invited en Kafka — el worker consumidor envía el correo vía SendGrid (ver OrganizationInvitationEventsConsumer). Responde en cuanto persiste, sin esperar al envío del correo.',
    }),
    ApiHeader({
      name: 'X-Account-Id',
      description:
        'UUID de la organización activa. El llamador debe ser ADMIN de esa cuenta.',
      required: true,
    }),
    ApiBody({ type: InviteMemberDto }),
    ApiResponse({
      status: 201,
      description: 'Invitación enviada correctamente',
    }),
    ApiResponse({
      status: 400,
      description:
        'Datos inválidos, falta el header X-Account-Id, o la cuenta activa no es de tipo ORGANIZATION',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description:
        'El usuario autenticado no es ADMIN de la organización activa',
    }),
  );
}

import { BadRequestException, Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { RolesService } from 'src/roles/roles.service';

import { AccountService } from '../account.service';
import { InviteMemberDto } from '../dto/invite-member.dto';
import { ACCOUNT_TYPE_ENUM } from '../enums/account-type.enum';
import { OrganizationInvitationService } from '../organization-invitation.service';

/**
 * Invita a alguien por correo a la organización activa (`POST /api/v1/organizations/invite`):
 * valida quién invita, persiste la invitación y publica el evento de Kafka que dispara el correo.
 *
 * La secuencia vive junta acá. Estaba repartida entre el controller y `AccountService.inviteMember`
 * sólo para esquivar una dependencia circular —`OrganizationInvitationService` ya depende de
 * `AccountService` para refrescar el catálogo al aceptar—, y como caso de uso el problema
 * desaparece: depende de ambos servicios y ninguno depende de él.
 *
 * El `accountId` de `X-Account-Id` es la fila de membresía del llamador, no la organización: el
 * `organizationId` se resuelve a partir de ella, y confundirlos dejaría invitar a una organización
 * con el identificador de otra.
 */
@Injectable()
export class InviteOrganizationMemberUseCase {
  constructor(
    private readonly accountService: AccountService,
    private readonly organizationInvitationService: OrganizationInvitationService,
    private readonly rolesService: RolesService,
  ) {}

  async execute(
    callerId: string,
    accountId: string,
    dto: InviteMemberDto,
  ): Promise<BaseResponse<null>> {
    if (!accountId) {
      throw new BadRequestException(
        'Falta el header X-Account-Id de la organización activa',
      );
    }

    const account = await this.accountService.assertHasOrganizationPermission(
      callerId,
      accountId,
      ACTION_KEY_ENUM.CREATE,
    );

    if (account.accountType !== ACCOUNT_TYPE_ENUM.ORGANIZATION) {
      throw new BadRequestException(
        'Solo se pueden invitar miembros a una cuenta de tipo ORGANIZATION',
      );
    }

    /**
     * El rol se valida antes de persistir nada: una invitación con un `roleId` inexistente se
     * aceptaría acá y reventaría al canjearse, cuando ya no hay quien corrija el error —el
     * invitado no eligió ese rol y quien invitó cree que la invitación salió bien.
     */
    await this.rolesService.findByIdOrFail(dto.roleId);

    await this.organizationInvitationService.create({
      organizationId: account.organizationId as string,
      roleId: dto.roleId,
      invitedBy: callerId,
      email: dto.email,
    });

    return {
      success: true,
      message: 'Invitación enviada correctamente',
      data: null,
    };
  }
}

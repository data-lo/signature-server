import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { RolesService } from 'src/roles/roles.service';
import { OrganizationMemberEventsProducer } from 'src/kafka/organization-member.producer';

import { AccountMemberService } from '../account-member.service';
import { UpdateAccountMemberDto } from '../dto/update-account-member.dto';
import { AccountEntity } from '../entities/account.entity';

/**
 * `PATCH /account-member/:id` y `PATCH /api/v1/organizations/members/:accountId/role`: cambia
 * el rol, el puesto o el estado de una membresía.
 *
 * Antes de cualquier escritura se comprueba que la organización no quede sin administradores.
 * Esa comprobación sólo hace falta cuando el cambio puede quitar uno: cambiar el puesto de
 * alguien, o reactivarlo, nunca reduce el número de administradores activos.
 *
 * **Reactivar cuenta como incorporación** y publica el mismo `organization.member.joined` que el
 * alta y la aceptación de una invitación: para quien administra la organización, alguien que fue
 * dado de baja y vuelve es alguien que hoy está dentro y ayer no. Cambiarle el rol o el puesto a
 * quien ya estaba activo no publica nada — no es una incorporación, y avisarlo convertiría el
 * aviso en ruido.
 */
@Injectable()
export class UpdateAccountMemberUseCase {
  constructor(
    private readonly accountMemberService: AccountMemberService,
    private readonly rolesService: RolesService,
    private readonly organizationMemberEventsProducer: OrganizationMemberEventsProducer,

    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(
    callerId: string,
    id: string,
    dto: UpdateAccountMemberDto,
  ): Promise<BaseResponse<AccountEntity>> {
    const member = await this.accountMemberService.findMembershipOrFail(id);

    await this.accountMemberService.assertHasOrganizationPermission(
      callerId,
      member.organizationId,
      ACTION_KEY_ENUM.UPDATE,
    );

    const changesRole =
      dto.roleId !== undefined && dto.roleId !== member.roleId;
    const deactivates = dto.isActive === false;

    if (changesRole || deactivates) {
      await this.accountMemberService.assertNotLastAdmin(
        member.organizationId,
        member,
      );
    }

    /**
     * El rol se valida contra la organización de la membresía, no sólo por existencia: un rol
     * custom de otra organización existe en la tabla, y aceptarlo aquí sería mover permisos de un
     * tenant a otro por el simple hecho de conocer su identificador.
     */
    if (dto.roleId) {
      await this.rolesService.findAssignableRoleOrFail(
        dto.roleId,
        member.organizationId as string,
      );
    }

    /**
     * Se mira el estado ANTERIOR: `dto.isActive === true` sobre quien ya estaba activo no
     * reactiva a nadie, y publicarlo mandaría un aviso de incorporación cada vez que alguien
     * edita el puesto de un miembro.
     */
    const reactivates = dto.isActive === true && !member.isActive;

    const updated = await this.dataSource.transaction(async (manager) => {
      await this.accountMemberService.applyMembershipUpdate(id, dto, manager);

      /**
       * Se relee dentro de la transacción y no se reutiliza `member`: el evento lleva el `roleId`
       * con el que la persona queda dentro, que puede ser el que este mismo update acaba de
       * cambiar.
       */
      const refreshed = await manager
        .getRepository(AccountEntity)
        .findOneOrFail({ where: { id } });

      if (reactivates) {
        await this.organizationMemberEventsProducer.enqueueJoined(manager, {
          membership: refreshed,
          actorUserId: callerId,
        });
      }

      return refreshed;
    });

    if (reactivates) {
      await this.organizationMemberEventsProducer.flushOutbox();
    }

    return {
      success: true,
      message: 'Membresía actualizada correctamente',
      data: updated,
    };
  }
}

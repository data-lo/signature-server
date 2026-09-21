import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { RolesService } from 'src/roles/roles.service';
import { OrganizationMemberEventsProducer } from 'src/kafka/organization-member.producer';

import { AccountMemberService } from '../account-member.service';
import { CreateAccountMemberDto } from '../dto/create-account-member.dto';
import { AccountEntity } from '../entities/account.entity';

/**
 * `POST /account-member`: da acceso directo a una organización a alguien que ya tiene cuenta,
 * sin pasar por el flujo de invitación por correo.
 *
 * Es el camino administrativo: quien lo usa ya sabe el `userId` del invitado, así que no hay
 * token que canjear ni correo que esperar.
 *
 * Avisa a propietarios y administradores igual que el alta desde la pantalla de miembros: para
 * quien administra la organización, por cuál de los dos endpoints entró la persona es un detalle
 * de implementación — lo que le importa es que hay alguien nuevo dentro.
 */
@Injectable()
export class GrantAccountAccessUseCase {
  constructor(
    private readonly accountMemberService: AccountMemberService,
    private readonly rolesService: RolesService,
    private readonly organizationMemberEventsProducer: OrganizationMemberEventsProducer,

    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(
    callerId: string,
    dto: CreateAccountMemberDto,
  ): Promise<BaseResponse<AccountEntity>> {
    await this.accountMemberService.assertHasOrganizationPermission(
      callerId,
      dto.organizationId,
      ACTION_KEY_ENUM.CREATE,
    );

    /**
     * Mismo criterio que el alta desde la pantalla de miembros: el rol tiene que ser del sistema
     * o de ESA organización. Aceptar un rol custom de otra movería sus permisos a un tenant que
     * no lo definió.
     */
    await this.rolesService.findAssignableRoleOrFail(
      dto.roleId,
      dto.organizationId,
    );

    /**
     * La membresía existente se busca sin filtrar por `isActive`: quien fue dado de baja
     * conserva su fila, y crear otra dejaría dos membresías de la misma persona en la misma
     * organización, con roles que podrían contradecirse.
     */
    const existingMembership =
      await this.accountMemberService.findExistingMembership(
        dto.organizationId,
        dto.userId,
      );
    if (existingMembership) {
      throw new ConflictException(
        'El usuario ya tiene acceso a esta organización',
      );
    }

    const invitedUser = await this.accountMemberService.findUserOrFail(
      dto.userId,
    );

    /**
     * La membresía y el evento que la anuncia se escriben juntos (ver
     * `OrganizationMemberEventsProducer`): un aviso de un acceso que la transacción terminó
     * deshaciendo sería peor que no avisar.
     *
     * El alta puede pedirse inactiva (`dto.isActive === false`), y entonces no hay incorporación
     * que anunciar: nadie ha quedado dentro todavía. Ese caso lo cubre la reactivación, que
     * publica el evento cuando la membresía se vuelve activa de verdad.
     */
    const membership = await this.dataSource.transaction(async (manager) => {
      const created = await this.accountMemberService.saveMembership(
        dto,
        invitedUser,
        manager,
      );

      if (created.isActive) {
        await this.organizationMemberEventsProducer.enqueueJoined(manager, {
          membership: created,
          actorUserId: callerId,
        });
      }

      return created;
    });

    await this.organizationMemberEventsProducer.flushOutbox();

    return {
      success: true,
      message: 'Acceso otorgado correctamente',
      data: membership,
    };
  }
}

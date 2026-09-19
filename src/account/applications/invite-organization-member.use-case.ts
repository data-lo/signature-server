import { BadRequestException, Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';
import { RolesService } from 'src/roles/roles.service';

import { AccountService } from '../account.service';
import { InviteMemberDto } from '../dto/invite-member.dto';
import { ACCOUNT_TYPE_ENUM } from '../enums/account-type.enum';
import { OrganizationInvitationService } from '../organization-invitation.service';

/**
 * `POST /api/v1/organizations/invite`: invita a alguien por correo a la organización activa
 * (ver historia [STORY] Eventos Kafka, Email (SendGrid) y Miembros (/join)).
 *
 * La secuencia completa —validar quién invita, persistir la invitación y publicar el evento de
 * Kafka que dispara el correo— vive acá. Antes estaba repartida entre el controller y
 * `AccountService.inviteMember`, y ese reparto existía sólo para esquivar una dependencia
 * circular: `OrganizationInvitationService` ya depende de `AccountService` para refrescar el
 * catálogo de Redis al aceptar, así que el sentido contrario no podía existir. Como caso de uso
 * el problema desaparece: éste depende de los dos servicios y ninguno de los dos depende de él.
 *
 * El `accountId` que llega en `X-Account-Id` es la fila de membresía del propio llamador, no la
 * organización: el `organizationId` real se resuelve a partir de ella. Son cosas distintas y
 * confundirlas dejaría invitar a una organización con el identificador de otra.
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

    /**
     * Sólo se resuelve la cuenta, no se vuelve a autorizar: de eso se encargó
     * `PermissionsGuard` con el `@RequirePermission(MEMBER, INVITE)` del controller, sobre el
     * mismo `X-Account-Id` que llega aquí. Antes se exigía `ORGANIZATION.CREATE`, un permiso
     * genérico que el catálogo estático ya no define para la organización; el permiso propio
     * del recurso (`MEMBER.INVITE`) es el que describe lo que de verdad se está haciendo.
     */
    const account = await this.accountService.resolveOwnActiveAccountOrFail(
      callerId,
      accountId,
    );

    if (account.accountType !== ACCOUNT_TYPE_ENUM.ORGANIZATION) {
      throw new BadRequestException(
        'Solo se pueden invitar miembros a una cuenta de tipo ORGANIZATION',
      );
    }

    const organizationId = account.organizationId as string;

    /**
     * El rol se valida antes de persistir nada: una invitación con un `roleId` inválido se
     * aceptaría acá y reventaría al canjearse, cuando ya no hay quien corrija el error —el
     * invitado no eligió ese rol y quien invitó cree que la invitación salió bien.
     *
     * Tiene que ser un rol asignable EN ESTA organización: uno de sistema o uno propio. Antes se
     * aceptaba cualquier rol que existiera, incluido el rol personalizado de otra organización.
     */
    const role = await this.rolesService.findAssignableRoleOrFail(
      dto.roleId,
      organizationId,
    );

    /**
     * OWNER no se reparte por invitación: lo recibe automáticamente quien crea la cuenta, y es
     * lo que distingue al dueño de un administrador nombrado por él. El modal ya no lo ofrece,
     * pero eso es sólo presentación: sin esta comprobación bastaría mandar su `roleId` a la API
     * para convertir en propietario a cualquiera. Para delegar la administración está ADMIN.
     */
    if (role.isSystemRole && role.name === SYSTEM_ROLE_NAME_ENUM.OWNER) {
      throw new BadRequestException(
        'El rol de propietario no se puede asignar por invitación',
      );
    }

    await this.organizationInvitationService.create({
      organizationId,
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

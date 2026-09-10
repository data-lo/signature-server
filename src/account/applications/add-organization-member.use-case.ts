import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { RolesService } from 'src/roles/roles.service';

import { AccountMemberService } from '../account-member.service';
import { AccountService } from '../account.service';
import { AddOrganizationMemberDto } from '../dto/add-organization-member.dto';
import { ACCOUNT_TYPE_ENUM } from '../enums/account-type.enum';
import { OrganizationMemberData } from '../interfaces/response/account-member-response';

/**
 * `POST /api/v1/organizations/members`: agrega a la organización activa a alguien que ya tiene
 * cuenta, asignándole un rol organizacional.
 *
 * Es el camino directo, hermano del de invitación por correo: la invitación existe para quien
 * todavía no está registrado (hay que esperar a que acepte), y esto para quien ya está dentro de
 * la plataforma, donde esa espera no aporta nada. Los permisos del nuevo miembro son los de su
 * rol; esta historia NO guarda permisos por persona.
 *
 * La organización se resuelve desde `X-Account-Id` —la membresía del propio llamador— y nunca
 * desde el body: es lo que hace imposible dar de alta a alguien en una organización ajena
 * cambiando un identificador. Mismo criterio que `InviteOrganizationMemberUseCase`.
 */
@Injectable()
export class AddOrganizationMemberUseCase {
  constructor(
    private readonly accountService: AccountService,
    private readonly accountMemberService: AccountMemberService,
    private readonly rolesService: RolesService,
  ) {}

  /**
   * Da de alta la membresía y devuelve la fila ya lista para pintar en la tabla de miembros.
   *
   * El orden de las validaciones es deliberado: primero quién pide (permiso sobre la cuenta
   * activa), luego el rol, luego el usuario y por último la membresía duplicada. Así el error que
   * se devuelve es siempre el primero que el administrador puede corregir, y no se filtra si un
   * correo existe a quien ni siquiera puede administrar la organización.
   *
   * Al terminar refresca el catálogo de cuentas cacheado del nuevo miembro, para que la
   * organización le aparezca en el selector sin tener que volver a iniciar sesión — lo mismo que
   * hace el flujo de invitación al aceptarla.
   *
   * @param callerId - Usuario autenticado que da el alta.
   * @param accountId - Header `X-Account-Id`: la membresía del llamador en la organización activa.
   * @param dto - Correo del usuario a agregar, rol a asignarle y puesto opcional.
   * @returns La membresía creada, con su rol, su estado y los permisos derivados del rol.
   *
   * @throws {BadRequestException} Si falta el header `X-Account-Id`, o si la cuenta activa no es
   * de tipo ORGANIZATION (una cuenta personal no tiene miembros que administrar).
   * @throws {ForbiddenException} Si el llamador no es miembro activo de esa cuenta o su rol no
   * tiene el permiso ORGANIZATION:CREATE.
   * @throws {NotFoundException} Si el rol no existe o es de otra organización, o si no hay ningún
   * usuario registrado con ese correo.
   * @throws {ConflictException} Si esa persona ya tiene una membresía en la organización, esté
   * activa o dada de baja.
   *
   * @example
   * ```ts
   * const response = await addOrganizationMember.execute(user.sub, accountId, {
   *   email: 'ana@empresa.com',
   *   roleId: 'role-member-1',
   * });
   * response.data.permissions; // los permisos que hereda del rol MEMBER
   * ```
   */
  async execute(
    callerId: string,
    accountId: string,
    dto: AddOrganizationMemberDto,
  ): Promise<BaseResponse<OrganizationMemberData>> {
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
        'Solo se pueden agregar miembros a una cuenta de tipo ORGANIZATION',
      );
    }

    const organizationId = account.organizationId as string;

    await this.rolesService.findAssignableRoleOrFail(
      dto.roleId,
      organizationId,
    );

    const invitedUser = await this.accountMemberService.findUserByEmailOrFail(
      dto.email,
    );

    /**
     * La membresía existente se busca sin filtrar por `isActive`: quien fue dado de baja conserva
     * su fila, y crear otra dejaría dos membresías de la misma persona en la misma organización,
     * con roles que podrían contradecirse. Los dos casos se distinguen en el mensaje porque se
     * arreglan distinto: uno ya está dentro, el otro hay que reactivarlo.
     */
    const existingMembership =
      await this.accountMemberService.findExistingMembership(
        organizationId,
        invitedUser.id,
      );

    if (existingMembership) {
      throw new ConflictException(
        existingMembership.isActive
          ? 'Esta persona ya es miembro de la organización'
          : 'Esta persona tiene una membresía dada de baja en la organización; reactívala en lugar de crear otra',
      );
    }

    const membership = await this.accountMemberService.saveMembership(
      {
        organizationId,
        userId: invitedUser.id,
        roleId: dto.roleId,
        position: dto.position,
      },
      invitedUser,
    );

    await this.accountService.appendAccountToCatalog(
      invitedUser.id,
      membership,
    );

    return {
      success: true,
      message: 'Miembro agregado correctamente',
      data: await this.accountMemberService.findDetailedMembership(
        membership.id,
      ),
    };
  }
}

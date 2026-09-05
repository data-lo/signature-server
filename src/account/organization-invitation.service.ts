import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { OrganizationInvitationEntity } from './entities/organization-invitation.entity';
import { AccountEntity } from './entities/account.entity';
import { OrganizationEntity } from './entities/organization.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { AccountService } from './account.service';
import { INVITATION_STATUS_ENUM } from './enums/invitation-status.enum';
import { ACCOUNT_TYPE_ENUM } from './enums/account-type.enum';
import { ACCOUNT_STATUS_ENUM } from './enums/account-status.enum';
import { OrganizationInvitationEventsProducer } from 'src/kafka/organization-invitation.producer';

const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 días — sin precedente en el repo, valor razonable para un enlace de invitación por correo.

interface CreateInvitationParams {
  organizationId: string;
  roleId: string;
  invitedBy: string;
  email: string;
}

/**
 * Gestiona el ciclo de vida de las invitaciones a organización.
 *
 * El token del correo ES la credencial que autoriza `acceptByRfc`, que se acepta sin JWT porque el
 * invitado puede no tener sesión todavía; la identidad se resuelve por RFC y no por igualdad de
 * correo. El detalle del tradeoff está en `AcceptOrganizationInvitationUseCase`.
 */
@Injectable()
export class OrganizationInvitationService {
  constructor(
    @InjectRepository(OrganizationInvitationEntity)
    private readonly invitationRepository: Repository<OrganizationInvitationEntity>,

    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,

    @InjectRepository(OrganizationEntity)
    private readonly organizationRepository: Repository<OrganizationEntity>,

    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,

    private readonly accountService: AccountService,
    private readonly invitationEventsProducer: OrganizationInvitationEventsProducer,
  ) {}

  async create(params: CreateInvitationParams): Promise<void> {
    const organization = await this.organizationRepository.findOne({
      where: { id: params.organizationId },
    });
    if (!organization) {
      throw new NotFoundException(
        `Organización con ID ${params.organizationId} no encontrada`,
      );
    }

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS);
    const email = params.email.toLowerCase();

    await this.invitationRepository.save(
      this.invitationRepository.create({
        organizationId: params.organizationId,
        roleId: params.roleId,
        invitedBy: params.invitedBy,
        email,
        token,
        status: INVITATION_STATUS_ENUM.PENDING,
        expiresAt,
      }),
    );

    this.invitationEventsProducer.emitInvited({
      email,
      organizationId: params.organizationId,
      organizationName: organization.name,
      roleId: params.roleId,
      invitationToken: token,
      invitedBy: params.invitedBy,
    });
  }

  /** Usuario dueño de ese RFC, exigiendo que exista. El RFC se guarda en mayúsculas. */
  async findUserByRfcOrFail(rfc: string): Promise<UserEntity> {
    const user = await this.userRepository.findOne({
      where: { personalInformation: { rfc: rfc.toUpperCase() } },
      relations: { personalInformation: true },
    });

    if (!user) {
      throw new NotFoundException(
        'No existe ningún usuario registrado con ese RFC',
      );
    }

    return user;
  }

  /**
   * Consuma la invitación de un usuario recién creado (camino B: RFC nuevo). La llama
   * `AuthService.register()` justo después de crear la cuenta, cuando el registro vino de un enlace
   * de invitación: el usuario ya se conoce por id, así que no hace falta el RFC.
   */
  async acceptForUser(token: string, userId: string): Promise<void> {
    const invitation = await this.resolveInvitation(token);
    this.assertPending(invitation);

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`Usuario con ID ${userId} no encontrado`);
    }

    await this.finalizeAcceptance(invitation, user);
  }

  async finalizeAcceptance(
    invitation: OrganizationInvitationEntity,
    user: UserEntity,
  ): Promise<void> {
    const existingMembership = await this.accountRepository.findOne({
      where: {
        organizationId: invitation.organizationId,
        userId: user.id,
        isActive: true,
      },
    });
    if (existingMembership) {
      throw new ConflictException('Ya eres miembro de esta organización');
    }

    const account = await this.accountRepository.save(
      this.accountRepository.create({
        userId: user.id,
        accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
        organizationId: invitation.organizationId,
        roleId: invitation.roleId,
        isActive: true,
        status: ACCOUNT_STATUS_ENUM.ACTIVE,
        email: user.email,
        password: user.password,
        joinedAt: new Date(),
      }),
    );
    account.organization = invitation.organization;

    invitation.status = INVITATION_STATUS_ENUM.ACCEPTED;
    await this.invitationRepository.save(invitation);

    await this.accountService.appendAccountToCatalog(user.id, account);
  }

  /** Expiración perezosa: se marca EXPIRED en el primer acceso posterior a expiresAt, no vía job programado (sin infraestructura de cron en este repo). */
  async resolveInvitation(
    token: string,
  ): Promise<OrganizationInvitationEntity> {
    const invitation = await this.invitationRepository.findOne({
      where: { token },
      relations: { organization: true },
    });
    if (!invitation) {
      throw new NotFoundException('Invitación no encontrada');
    }

    if (
      invitation.status === INVITATION_STATUS_ENUM.PENDING &&
      invitation.expiresAt.getTime() < Date.now()
    ) {
      invitation.status = INVITATION_STATUS_ENUM.EXPIRED;
      await this.invitationRepository.save(invitation);
    }

    return invitation;
  }

  assertPending(invitation: OrganizationInvitationEntity): void {
    if (invitation.status === INVITATION_STATUS_ENUM.ACCEPTED) {
      throw new ConflictException('Esta invitación ya fue utilizada');
    }
    if (invitation.status === INVITATION_STATUS_ENUM.EXPIRED) {
      throw new GoneException('Esta invitación ya expiró');
    }
  }
}

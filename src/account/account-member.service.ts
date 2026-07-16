// External dependencies
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

// DTOs
import { CreateAccountMemberDto } from './dto/create-account-member.dto';
import { UpdateAccountMemberDto } from './dto/update-account-member.dto';

// Entities
import { AccountMemberEntity } from './entities/account-member.entity';

// Enums
import { ACCOUNT_MEMBER_ROLE_ENUM } from './enums/account-member-role.enum';

// Services
import { AccountService } from './account.service';

// Interfaces
import { BaseResponse } from 'src/interfaces/api-response.dto';

@Injectable()
export class AccountMemberService {
  constructor(
    @InjectRepository(AccountMemberEntity)
    private accountMemberRepository: Repository<AccountMemberEntity>,

    private readonly accountService: AccountService,
  ) {}

  async create(
    callerId: string,
    createAccountMemberDto: CreateAccountMemberDto,
  ): Promise<BaseResponse<AccountMemberEntity>> {
    await this.assertIsOwner(callerId, createAccountMemberDto.accountId);

    const existingMembership = await this.accountMemberRepository.findOne({
      where: {
        accountId: createAccountMemberDto.accountId,
        userId: createAccountMemberDto.userId,
      },
    });

    if (existingMembership) {
      throw new ConflictException('El usuario ya tiene acceso a esta cuenta');
    }

    const member = this.accountMemberRepository.create({
      accountId: createAccountMemberDto.accountId,
      userId: createAccountMemberDto.userId,
      role: createAccountMemberDto.role,
      position: createAccountMemberDto.position,
      isActive: createAccountMemberDto.isActive ?? true,
    });

    const newMember = await this.accountMemberRepository.save(member);

    return {
      success: true,
      message: 'Acceso otorgado correctamente',
      data: newMember,
    };
  }

  async findByAccount(
    callerId: string,
    accountId: string,
  ): Promise<BaseResponse<AccountMemberEntity[]>> {
    await this.assertIsOwner(callerId, accountId);

    const members = await this.accountMemberRepository.find({
      where: { accountId },
    });

    return {
      success: true,
      message: 'Miembros obtenidos correctamente',
      data: members,
    };
  }

  async findOne(
    callerId: string,
    id: string,
  ): Promise<BaseResponse<AccountMemberEntity>> {
    const member = await this.findEntityById(id);
    await this.assertIsOwner(callerId, member.accountId);

    return {
      success: true,
      message: 'Miembro obtenido correctamente',
      data: member,
    };
  }

  async update(
    callerId: string,
    id: string,
    updateAccountMemberDto: UpdateAccountMemberDto,
  ): Promise<BaseResponse<AccountMemberEntity>> {
    const member = await this.findEntityById(id);
    await this.assertIsOwner(callerId, member.accountId);

    await this.accountMemberRepository.update(id, {
      ...(updateAccountMemberDto.role && { role: updateAccountMemberDto.role }),
      ...(updateAccountMemberDto.position !== undefined && {
        position: updateAccountMemberDto.position,
      }),
      ...(updateAccountMemberDto.isActive !== undefined && {
        isActive: updateAccountMemberDto.isActive,
      }),
    });

    return {
      success: true,
      message: 'Membresía actualizada correctamente',
      data: await this.findEntityById(id),
    };
  }

  async remove(callerId: string, id: string): Promise<BaseResponse> {
    const membership = await this.accountMemberRepository.findOne({
      where: { id, isActive: true },
    });
    if (!membership) {
      throw new NotFoundException(`Membresía con ID ${id} no encontrada`);
    }
    await this.assertIsOwner(callerId, membership.accountId);

    await this.accountMemberRepository.update(id, { isActive: false });

    await this.accountService.removeAccountFromCatalog(
      membership.userId,
      membership.accountId,
    );

    return {
      success: true,
      message: 'Acceso revocado correctamente',
    };
  }

  private async findEntityById(id: string): Promise<AccountMemberEntity> {
    const member = await this.accountMemberRepository.findOne({
      where: { id },
    });

    if (!member) {
      throw new NotFoundException(`Membresía con ID ${id} no encontrada`);
    }

    return member;
  }

  /**
   * Solo un OWNER activo de la cuenta puede leer/otorgar/revocar/actualizar
   * sus membresías. Lanza ForbiddenException si el llamador no lo es.
   */
  private async assertIsOwner(
    callerId: string,
    accountId: string,
  ): Promise<void> {
    const callerMembership = await this.accountMemberRepository.findOne({
      where: { userId: callerId, accountId, isActive: true },
    });

    if (!callerMembership?.role?.includes(ACCOUNT_MEMBER_ROLE_ENUM.OWNER)) {
      throw new ForbiddenException(
        'No tienes permisos de OWNER sobre esta cuenta',
      );
    }
  }

  /**
   * Check de tenant más laxo que assertIsOwner: cualquier miembro activo de
   * la cuenta (sin importar su role) puede operar dentro de ese contexto —
   * usado por módulos donde pertenecer a la cuenta basta (p. ej. crear o
   * listar documentos scopeados por la cuenta activa), a diferencia de
   * gestionar la membresía misma, que sigue siendo solo-OWNER.
   */
  async assertIsActiveMember(userId: string, accountId: string): Promise<void> {
    const membership = await this.accountMemberRepository.findOne({
      where: { userId, accountId, isActive: true },
    });

    if (!membership) {
      throw new ForbiddenException('No perteneces a esta cuenta');
    }
  }
}

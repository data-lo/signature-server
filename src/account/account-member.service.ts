// External dependencies
import {
  ConflictException,
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

// Interfaces
import { BaseResponse } from 'src/interfaces/api-response.dto';

@Injectable()
export class AccountMemberService {
  constructor(
    @InjectRepository(AccountMemberEntity)
    private accountMemberRepository: Repository<AccountMemberEntity>,
  ) {}

  async create(
    createAccountMemberDto: CreateAccountMemberDto,
  ): Promise<BaseResponse<AccountMemberEntity>> {
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
    accountId: string,
  ): Promise<BaseResponse<AccountMemberEntity[]>> {
    const members = await this.accountMemberRepository.find({
      where: { accountId },
    });

    return {
      success: true,
      message: 'Miembros obtenidos correctamente',
      data: members,
    };
  }

  async findOne(id: string): Promise<BaseResponse<AccountMemberEntity>> {
    const member = await this.findEntityById(id);

    return {
      success: true,
      message: 'Miembro obtenido correctamente',
      data: member,
    };
  }

  async update(
    id: string,
    updateAccountMemberDto: UpdateAccountMemberDto,
  ): Promise<BaseResponse<AccountMemberEntity>> {
    await this.findEntityById(id);

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

  async remove(id: string): Promise<BaseResponse> {
    const result = await this.accountMemberRepository.update(
      { id, isActive: true },
      { isActive: false },
    );

    if (result.affected === 0) {
      throw new NotFoundException(`Membresía con ID ${id} no encontrada`);
    }

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
}

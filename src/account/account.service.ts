// External dependencies
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

// DTOs
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

// Entities
import { AccountEntity } from './entities/account.entity';
import { OrganizationDetailEntity } from './entities/organization-detail.entity';

// Enums
import { ACCOUNT_TYPE_ENUM } from './enums/account-type.enum';

// Interfaces
import { BaseResponse } from 'src/interfaces/api-response.dto';

@Injectable()
export class AccountService {
  constructor(
    @InjectRepository(AccountEntity)
    private accountRepository: Repository<AccountEntity>,

    @InjectRepository(OrganizationDetailEntity)
    private organizationDetailRepository: Repository<OrganizationDetailEntity>,
  ) {}

  async create(
    createAccountDto: CreateAccountDto,
  ): Promise<BaseResponse<AccountEntity>> {
    const account = this.accountRepository.create({
      name: createAccountDto.name,
      type: createAccountDto.type,
    });

    const newAccount = await this.accountRepository.save(account);

    if (newAccount.type === ACCOUNT_TYPE_ENUM.ORGANIZATION) {
      const organizationDetail = this.organizationDetailRepository.create({
        accountId: newAccount.id,
        name: createAccountDto.organizationName,
      });
      await this.organizationDetailRepository.save(organizationDetail);
    }

    return {
      success: true,
      message: 'Cuenta creada correctamente',
      data: await this.findEntityById(newAccount.id),
    };
  }

  async findAll(): Promise<BaseResponse<AccountEntity[]>> {
    const accounts = await this.accountRepository.find({
      relations: { organizationDetail: true },
    });

    return {
      success: true,
      message: 'Cuentas obtenidas correctamente',
      data: accounts,
    };
  }

  async findOne(id: string): Promise<BaseResponse<AccountEntity>> {
    const account = await this.findEntityById(id);

    return {
      success: true,
      message: 'Cuenta obtenida correctamente',
      data: account,
    };
  }

  async update(
    id: string,
    updateAccountDto: UpdateAccountDto,
  ): Promise<BaseResponse<AccountEntity>> {
    const account = await this.findEntityById(id);

    await this.accountRepository.update(id, {
      ...(updateAccountDto.name && { name: updateAccountDto.name }),
    });

    if (
      account.type === ACCOUNT_TYPE_ENUM.ORGANIZATION &&
      updateAccountDto.organizationName
    ) {
      await this.organizationDetailRepository.update(id, {
        name: updateAccountDto.organizationName,
      });
    }

    return {
      success: true,
      message: 'Cuenta actualizada correctamente',
      data: await this.findEntityById(id),
    };
  }

  private async findEntityById(id: string): Promise<AccountEntity> {
    const account = await this.accountRepository.findOne({
      where: { id },
      relations: { organizationDetail: true },
    });

    if (!account) {
      throw new NotFoundException(`Cuenta con ID ${id} no encontrada`);
    }

    return account;
  }
}

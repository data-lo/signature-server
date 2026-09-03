import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';

import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

import { CreateAccountUseCase } from './applications/create-account.use-case';
import { ListAccountsUseCase } from './applications/list-accounts.use-case';
import { GetAccountUseCase } from './applications/get-account.use-case';
import { UpdateAccountUseCase } from './applications/update-account.use-case';

import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

import { ApiCreateAccount } from './docs/api-create-account.docs';
import { ApiGetAccounts } from './docs/api-get-accounts.docs';
import { ApiGetAccount } from './docs/api-get-account.docs';
import { ApiUpdateAccount } from './docs/api-update-account.docs';

@ApiTags('Account')
@ApiBearerAuth('access-token')
@Controller('account')
export class AccountController {
  constructor(
    private readonly createAccount: CreateAccountUseCase,
    private readonly listAccounts: ListAccountsUseCase,
    private readonly getAccount: GetAccountUseCase,
    private readonly updateAccount: UpdateAccountUseCase,
  ) {}

  @Post()
  @ApiCreateAccount()
  create(
    @CurrentUser() user: JwtPayload,
    @Body() createAccountDto: CreateAccountDto,
  ) {
    return this.createAccount.execute(user.sub, createAccountDto);
  }

  @Get()
  @ApiGetAccounts()
  findAll() {
    return this.listAccounts.execute();
  }

  @Get(':id')
  @ApiGetAccount()
  findOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.getAccount.execute(user.sub, id);
  }

  @Patch(':id')
  @ApiUpdateAccount()
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() updateAccountDto: UpdateAccountDto,
  ) {
    return this.updateAccount.execute(user.sub, id, updateAccountDto);
  }
}

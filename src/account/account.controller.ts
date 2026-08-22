// NestJS core
import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';

// Swagger
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

// Auth
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

// Service
import { AccountService } from './account.service';

// DTOs
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

// Docs
import { ApiCreateAccount } from './docs/api-create-account.docs';
import { ApiGetAccounts } from './docs/api-get-accounts.docs';
import { ApiGetAccount } from './docs/api-get-account.docs';
import { ApiUpdateAccount } from './docs/api-update-account.docs';

@ApiTags('Account')
@ApiBearerAuth('access-token')
@Controller('account')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Post()
  @ApiCreateAccount()
  create(
    @CurrentUser() user: JwtPayload,
    @Body() createAccountDto: CreateAccountDto,
  ) {
    return this.accountService.create(user.sub, createAccountDto);
  }

  @Get()
  @ApiGetAccounts()
  findAll() {
    return this.accountService.findAll();
  }

  @Get(':id')
  @ApiGetAccount()
  findOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.accountService.findOne(user.sub, id);
  }

  @Patch(':id')
  @ApiUpdateAccount()
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() updateAccountDto: UpdateAccountDto,
  ) {
    return this.accountService.update(user.sub, id, updateAccountDto);
  }
}

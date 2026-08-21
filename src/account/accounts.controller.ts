// NestJS core
import { Controller, Get } from '@nestjs/common';

// Swagger
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

// Auth
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

// Service
import { AccountService } from './account.service';
import { ApiGetMyAccounts } from './docs/api-get-my-accounts.docs';

@ApiTags('Accounts')
@ApiBearerAuth('access-token')
@Controller('api/v1/accounts')
export class AccountsController {
  constructor(private readonly accountService: AccountService) {}

  @Get('me')
  @ApiGetMyAccounts()
  getMe(@CurrentUser() user: JwtPayload) {
    return this.accountService.getAccountsCatalog(user.sub);
  }
}

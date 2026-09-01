// NestJS core
import { Controller, Get } from '@nestjs/common';

// Swagger
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

// Auth
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

// Use cases
import { GetMyAccountsUseCase } from './applications/get-my-accounts.use-case';

// Docs
import { ApiGetMyAccounts } from './docs/api-get-my-accounts.docs';

@ApiTags('Accounts')
@ApiBearerAuth('access-token')
@Controller('accounts')
export class AccountsController {
  constructor(private readonly getMyAccounts: GetMyAccountsUseCase) {}

  @Get('me')
  @ApiGetMyAccounts()
  getMe(@CurrentUser() user: JwtPayload) {
    return this.getMyAccounts.execute(user.sub);
  }
}

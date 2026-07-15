// NestJS core
import { Controller, Get } from '@nestjs/common';

// Swagger
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

// Auth
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

// Service
import { AccountService } from './account.service';
import { AccountListResponse } from './interfaces/response/account-response';

@ApiTags('Accounts')
@ApiBearerAuth('access-token')
@Controller('api/v1/accounts')
export class AccountsController {
  constructor(private readonly accountService: AccountService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Obtener el catálogo de cuentas del usuario autenticado',
    description:
      'Lee exclusivamente desde Redis DB 0 (key accounts:{userId}) el listado unificado de cuentas Personal y Organización del usuario',
  })
  @ApiResponse({
    status: 200,
    description: 'Catálogo de cuentas obtenido correctamente',
    type: AccountListResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  getMe(@CurrentUser() user: JwtPayload) {
    return this.accountService.getAccountsCatalog(user.sub);
  }
}

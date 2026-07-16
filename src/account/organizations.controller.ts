// NestJS core
import { Body, Controller, Post } from '@nestjs/common';

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

// DTOs
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { AccountResponse } from './interfaces/response/account-response';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

@ApiTags('Organizations')
@ApiBearerAuth('access-token')
@Controller('api/v1/organizations')
export class OrganizationsController {
  constructor(private readonly accountService: AccountService) {}

  @Post()
  @ApiOperation({
    summary: 'Crear una organización',
    description:
      'Crea de forma transaccional la Account(ORGANIZATION), su OrganizationDetail y la membresía del usuario autenticado (roleId inicial NULL), y refresca el catálogo de cuentas en Redis',
  })
  @ApiResponse({
    status: 201,
    description: 'Organización creada correctamente',
    type: AccountResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Los datos enviados son inválidos o incompletos',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateOrganizationDto) {
    return this.accountService.createOrganization(user.sub, dto);
  }
}

// NestJS core
import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';

// Swagger
import {
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';

// Auth
import { Public, RequireAuth } from 'src/auth/decorators/public.decorator';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

// Service
import { AccountService } from './account.service';

// DTOs
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import {
  AccountListResponse,
  AccountResponse,
} from './interfaces/response/account-response';
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

@Public()
@ApiTags('Account')
@ApiSecurity('x-api-key')
@Controller('account')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Post()
  @ApiOperation({
    summary: 'Crear nueva cuenta',
    description: 'Crea un nuevo espacio de trabajo personal u organizacional',
  })
  @ApiResponse({
    status: 201,
    description: 'Cuenta creada correctamente',
    type: AccountResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Los datos enviados son inválidos o incompletos',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'API Key inválida o no proporcionada',
  })
  create(@Body() createAccountDto: CreateAccountDto) {
    return this.accountService.create(createAccountDto);
  }

  @RequireAuth()
  @Post('organization')
  @ApiOperation({
    summary: 'Crear una organización',
    description:
      'Crea de forma transaccional la Account(ORGANIZATION), su OrganizationDetail y la membresía OWNER del usuario autenticado, y refresca el catálogo de cuentas en Redis',
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
  createOrganization(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateOrganizationDto,
  ) {
    return this.accountService.createOrganization(user.sub, dto);
  }

  @RequireAuth()
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
  getAccountsCatalog(@CurrentUser() user: JwtPayload) {
    return this.accountService.getAccountsCatalog(user.sub);
  }

  @Get()
  @ApiOperation({ summary: 'Obtener todas las cuentas' })
  @ApiResponse({
    status: 200,
    description: 'Lista de cuentas obtenida correctamente',
    type: AccountListResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'API Key inválida o no proporcionada',
  })
  findAll() {
    return this.accountService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener una cuenta' })
  @ApiParam({
    name: 'id',
    description: 'Identificador único de la cuenta en formato UUID v4',
    format: 'uuid',
    example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa',
  })
  @ApiResponse({
    status: 200,
    description: 'Cuenta encontrada',
    type: AccountResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'API Key inválida o no proporcionada',
  })
  @ApiResponse({
    status: 404,
    description: 'Cuenta no encontrada',
    type: NotFoundResponse,
  })
  findOne(@Param('id') id: string) {
    return this.accountService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar datos de una cuenta' })
  @ApiParam({
    name: 'id',
    description: 'Identificador único de la cuenta en formato UUID v4',
    format: 'uuid',
    example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa',
  })
  @ApiResponse({
    status: 200,
    description: 'Cuenta actualizada correctamente',
    type: AccountResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'API Key inválida o no proporcionada',
  })
  @ApiResponse({
    status: 404,
    description: 'Cuenta no encontrada',
    type: NotFoundResponse,
  })
  update(@Param('id') id: string, @Body() updateAccountDto: UpdateAccountDto) {
    return this.accountService.update(id, updateAccountDto);
  }
}

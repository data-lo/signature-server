// NestJS core
import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';

// Swagger
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

// Auth
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

// Service
import { AccountService } from './account.service';

// DTOs
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import {
  AccountListResponse,
  AccountResponse,
} from './interfaces/response/account-response';
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

@ApiTags('Account')
@ApiBearerAuth('access-token')
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
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  create(
    @CurrentUser() user: JwtPayload,
    @Body() createAccountDto: CreateAccountDto,
  ) {
    return this.accountService.create(user.sub, createAccountDto);
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
    description: 'Token de autenticación inválido, expirado o no proporcionado',
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
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es ADMIN de esta cuenta',
  })
  @ApiResponse({
    status: 404,
    description: 'Cuenta no encontrada',
    type: NotFoundResponse,
  })
  findOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.accountService.findOne(user.sub, id);
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
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es ADMIN de esta cuenta',
  })
  @ApiResponse({
    status: 404,
    description: 'Cuenta no encontrada',
    type: NotFoundResponse,
  })
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() updateAccountDto: UpdateAccountDto,
  ) {
    return this.accountService.update(user.sub, id, updateAccountDto);
  }
}

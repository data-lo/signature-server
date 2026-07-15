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
import { Public } from 'src/auth/decorators/public.decorator';

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

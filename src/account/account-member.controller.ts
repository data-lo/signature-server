// NestJS core
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

// Swagger
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';

// Auth
import { Public } from 'src/auth/decorators/public.decorator';

// Service
import { AccountMemberService } from './account-member.service';

// DTOs
import { CreateAccountMemberDto } from './dto/create-account-member.dto';
import { UpdateAccountMemberDto } from './dto/update-account-member.dto';
import {
  AccountMemberListResponse,
  AccountMemberResponse,
} from './interfaces/response/account-member-response';
import {
  BadRequestResponse,
  BaseResponse,
  ConflictResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

@Public()
@ApiTags('Account Member')
@ApiSecurity('x-api-key')
@Controller('account-member')
export class AccountMemberController {
  constructor(private readonly accountMemberService: AccountMemberService) {}

  @Post()
  @ApiOperation({
    summary: 'Otorgar acceso a una cuenta',
    description: 'Asocia un usuario a una cuenta con uno o más roles',
  })
  @ApiResponse({
    status: 201,
    description: 'Acceso otorgado correctamente',
    type: AccountMemberResponse,
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
  @ApiResponse({
    status: 409,
    description: 'El usuario ya tiene acceso a esta cuenta',
    type: ConflictResponse,
  })
  create(@Body() createAccountMemberDto: CreateAccountMemberDto) {
    return this.accountMemberService.create(createAccountMemberDto);
  }

  @Get()
  @ApiOperation({ summary: 'Obtener los miembros de una cuenta' })
  @ApiQuery({
    name: 'accountId',
    required: true,
    type: String,
    description: 'UUID de la cuenta',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de miembros obtenida correctamente',
    type: AccountMemberListResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'API Key inválida o no proporcionada',
  })
  findByAccount(@Query('accountId') accountId: string) {
    return this.accountMemberService.findByAccount(accountId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener una membresía' })
  @ApiParam({
    name: 'id',
    description: 'Identificador único de la membresía en formato UUID v4',
    format: 'uuid',
    example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa',
  })
  @ApiResponse({
    status: 200,
    description: 'Membresía encontrada',
    type: AccountMemberResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'API Key inválida o no proporcionada',
  })
  @ApiResponse({
    status: 404,
    description: 'Membresía no encontrada',
    type: NotFoundResponse,
  })
  findOne(@Param('id') id: string) {
    return this.accountMemberService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Actualizar una membresía',
    description: 'Actualiza el rol, puesto o vigencia del acceso',
  })
  @ApiParam({
    name: 'id',
    description: 'Identificador único de la membresía en formato UUID v4',
    format: 'uuid',
    example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa',
  })
  @ApiResponse({
    status: 200,
    description: 'Membresía actualizada correctamente',
    type: AccountMemberResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'API Key inválida o no proporcionada',
  })
  @ApiResponse({
    status: 404,
    description: 'Membresía no encontrada',
    type: NotFoundResponse,
  })
  update(
    @Param('id') id: string,
    @Body() updateAccountMemberDto: UpdateAccountMemberDto,
  ) {
    return this.accountMemberService.update(id, updateAccountMemberDto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Revocar acceso',
    description: 'Marca el acceso del usuario a la cuenta como no vigente',
  })
  @ApiParam({
    name: 'id',
    description: 'Identificador único de la membresía en formato UUID v4',
    format: 'uuid',
    example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa',
  })
  @ApiResponse({
    status: 200,
    description: 'Acceso revocado correctamente',
    type: BaseResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'API Key inválida o no proporcionada',
  })
  @ApiResponse({
    status: 404,
    description: 'Membresía no encontrada',
    type: NotFoundResponse,
  })
  remove(@Param('id') id: string) {
    return this.accountMemberService.remove(id);
  }
}

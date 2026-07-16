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
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

// Auth
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

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

@ApiTags('Account Member')
@ApiBearerAuth('access-token')
@Controller('account-member')
export class AccountMemberController {
  constructor(private readonly accountMemberService: AccountMemberService) {}

  @Post()
  @ApiOperation({
    summary: 'Otorgar acceso a una cuenta',
    description:
      'Asocia un usuario a una cuenta con uno o más roles. Solo un OWNER activo de esa cuenta puede otorgar acceso.',
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
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es OWNER de esta cuenta',
  })
  @ApiResponse({
    status: 409,
    description: 'El usuario ya tiene acceso a esta cuenta',
    type: ConflictResponse,
  })
  create(
    @CurrentUser() user: JwtPayload,
    @Body() createAccountMemberDto: CreateAccountMemberDto,
  ) {
    return this.accountMemberService.create(user.sub, createAccountMemberDto);
  }

  @Get()
  @ApiOperation({
    summary: 'Obtener los miembros de una cuenta',
    description:
      'Solo un OWNER activo de esa cuenta puede listar sus miembros.',
  })
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
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es OWNER de esta cuenta',
  })
  findByAccount(
    @CurrentUser() user: JwtPayload,
    @Query('accountId') accountId: string,
  ) {
    return this.accountMemberService.findByAccount(user.sub, accountId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Obtener una membresía',
    description:
      'Solo un OWNER activo de la cuenta de esa membresía puede consultarla.',
  })
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
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es OWNER de esta cuenta',
  })
  @ApiResponse({
    status: 404,
    description: 'Membresía no encontrada',
    type: NotFoundResponse,
  })
  findOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.accountMemberService.findOne(user.sub, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Actualizar una membresía',
    description:
      'Actualiza el rol, puesto o vigencia del acceso. Solo un OWNER activo de la cuenta de esa membresía puede hacerlo.',
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
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es OWNER de esta cuenta',
  })
  @ApiResponse({
    status: 404,
    description: 'Membresía no encontrada',
    type: NotFoundResponse,
  })
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() updateAccountMemberDto: UpdateAccountMemberDto,
  ) {
    return this.accountMemberService.update(
      user.sub,
      id,
      updateAccountMemberDto,
    );
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Revocar acceso',
    description:
      'Marca el acceso del usuario a la cuenta como no vigente. Solo un OWNER activo de esa cuenta puede revocar acceso.',
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
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es OWNER de esta cuenta',
  })
  @ApiResponse({
    status: 404,
    description: 'Membresía no encontrada',
    type: NotFoundResponse,
  })
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.accountMemberService.remove(user.sub, id);
  }
}

// NestJS core
import { Body, Controller, Post } from '@nestjs/common';

// Swagger
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

// Auth
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { ActiveAccountId } from 'src/auth/decorators/active-account-id.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

// Service
import { AccountService } from './account.service';

// DTOs
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
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
      'Crea de forma transaccional la Account(ORGANIZATION), su OrganizationDetail y la membresía con el rol de sistema ADMIN del usuario autenticado (el creador queda como administrador de inmediato), y refresca el catálogo de cuentas en Redis',
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

  @Post('invite')
  @ApiOperation({
    summary: 'Invitar a un nuevo miembro a la organización activa',
    description:
      'Alcance delimitado: valida el payload y que el llamador sea ADMIN de la organización activa (X-Account-Id), y responde éxito. No envía correo, no genera token de invitación, ni inserta ninguna membresía todavía (ver README, sección Pendientes).',
  })
  @ApiHeader({
    name: 'X-Account-Id',
    description:
      'UUID de la organización activa. El llamador debe ser ADMIN de esa cuenta.',
    required: true,
  })
  @ApiBody({ type: InviteMemberDto })
  @ApiResponse({
    status: 201,
    description: 'Invitación registrada correctamente',
  })
  @ApiResponse({
    status: 400,
    description:
      'Datos inválidos, falta el header X-Account-Id, o la cuenta activa no es de tipo ORGANIZATION',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El usuario autenticado no es ADMIN de la organización activa',
  })
  invite(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string,
    @Body() dto: InviteMemberDto,
  ) {
    return this.accountService.inviteMember(user.sub, accountId, dto);
  }
}

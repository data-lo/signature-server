import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiExcludeEndpoint, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/auth/decorators/public.decorator';
import { AuditService } from './audit.service';
import { CreateAuditDto } from './dto/create-audit.dto';
import { FindAllAuditDto } from './dto/find-audit.dto';

@ApiTags('Audit')
@ApiBearerAuth('access-token')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Post()
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Registrar entrada de auditoría' })
  @ApiBody({ type: CreateAuditDto })
  @ApiResponse({ status: 201, description: 'Registro de auditoría creado correctamente' })
  @ApiResponse({ status: 400, description: 'Datos de entrada inválidos' })
  create(@Body() createAuditDto: CreateAuditDto) {
    return this.auditService.create(createAuditDto);
  }

  @Get()
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Obtener todos los registros de auditoría' })
  @ApiResponse({ status: 200, description: 'Lista de registros de auditoría' })
  findAll() {
    return this.auditService.findAll();
  }
}

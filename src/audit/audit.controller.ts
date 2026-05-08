import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiExcludeEndpoint, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { CreateAuditDto } from './dto/create-audit.dto';
import { FindAllAuditDto } from './dto/find-audit.dto';
import { LogService } from 'src/log/log.service';

@ApiTags('Audit')
@ApiBearerAuth('access-token')
@Controller('audit')
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
    private readonly logService: LogService,
  ) {}

  @Post()
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Registrar entrada de auditoría' })
  @ApiBody({ type: CreateAuditDto })
  @ApiResponse({ status: 201, description: 'Registro de auditoría creado correctamente' })
  @ApiResponse({ status: 400, description: 'Datos de entrada inválidos' })
  create(@Body() createAuditDto: CreateAuditDto) {
    void this.logService.write('[Audit] create');
    return this.auditService.create(createAuditDto);
  }

  @Get()
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Obtener todos los registros de auditoría' })
  @ApiResponse({ status: 200, description: 'Lista de registros de auditoría' })
  findAll(@Query() query: FindAllAuditDto) {
    void this.logService.write('[Audit] findAll');
    return this.auditService.findAll(query);
  }
}

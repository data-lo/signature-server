import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/auth/decorators/public.decorator';
import { AuditService } from './audit.service';
import { CreateAuditDto } from './dto/create-audit.dto';
import { FindAllAuditDto } from './dto/find-audit.dto';

@ApiTags('Audit')
@ApiBearerAuth('access-token')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Public()
  @Post()
  @ApiOperation({ summary: 'Registrar entrada de auditoría' })
  @ApiResponse({ status: 201, description: 'Registro de auditoría creado correctamente' })
  create(@Body() createAuditDto: CreateAuditDto) {
    return this.auditService.create(createAuditDto);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Obtener registros de auditoría' })
  @ApiResponse({ status: 200, description: 'Lista de registros de auditoría paginada' })
  findAll(@Query() query: FindAllAuditDto) {
    return this.auditService.findAll(query);
  }
}

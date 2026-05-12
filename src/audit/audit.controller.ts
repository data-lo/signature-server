import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { FindAllAuditDto } from './dto/find-audit.dto';

@ApiTags('Audit')
@ApiBearerAuth('access-token')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('document/:documentId')
  @ApiOperation({ summary: 'Obtener registros de auditoría de un documento descifrados' })
  @ApiParam({ name: 'documentId', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Lista de registros de auditoría descifrados, ordenados por chainIndex ASC' })
  @ApiResponse({ status: 404, description: 'No se encontraron registros para el documento' })
  findByDocument(@Param('documentId') documentId: string) {
    return this.auditService.findOne(documentId);
  }

  @Get()
  @ApiOperation({ summary: 'Obtener todos los registros de auditoría' })
  @ApiResponse({ status: 200, description: 'Lista paginada de registros de auditoría' })
  findAll(@Query() query: FindAllAuditDto) {
    return this.auditService.findAll(query);
  }
}

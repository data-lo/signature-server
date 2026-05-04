import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/auth/decorators/public.decorator';
import { AuditService } from './audit.service';
import { CreateAuditDto } from './dto/create-audit.dto';
import { UpdateAuditDto } from './dto/update-audit.dto';

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
  @ApiOperation({ summary: 'Obtener todos los registros de auditoría' })
  @ApiResponse({ status: 200, description: 'Lista de registros de auditoría' })
  findAll() {
    return this.auditService.findAll();
  }

  // @Public()
  // @Get(':id')
  // @ApiOperation({ summary: 'Obtener registro de auditoría por ID' })
  // @ApiParam({ name: 'id', description: 'ID del registro de auditoría' })
  // @ApiResponse({ status: 200, description: 'Registro encontrado' })
  // @ApiResponse({ status: 404, description: 'Registro no encontrado' })
  // findOne(@Param('id') id: string) {
  //   return this.auditService.findOne(+id);
  // }

  // @Public()
  // @Patch(':id')
  // @ApiOperation({ summary: 'Actualizar registro de auditoría' })
  // @ApiParam({ name: 'id', description: 'ID del registro de auditoría' })
  // @ApiResponse({ status: 200, description: 'Registro actualizado correctamente' })
  // update(@Param('id') id: string, @Body() updateAuditDto: UpdateAuditDto) {
  //   return this.auditService.update(+id, updateAuditDto);
  // }

  // @Public()
  // @Delete(':id')
  // @ApiOperation({ summary: 'Eliminar registro de auditoría' })
  // @ApiParam({ name: 'id', description: 'ID del registro de auditoría' })
  // @ApiResponse({ status: 200, description: 'Registro eliminado correctamente' })
  // remove(@Param('id') id: string) {
  //   return this.auditService.remove(+id);
  // }
}

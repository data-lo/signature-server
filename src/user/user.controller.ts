// NestJS core
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

// Swagger
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';

// Auth
import { Public } from 'src/auth/decorators/public.decorator';

// Service
import { UserService } from './user.service';

// DTOs
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserCreateData, UserCreateResponse } from './interfaces/response/user-create-response';
import { BadRequestResponse, NotFoundResponse, BaseResponse, ConflictResponse } from 'src/interfaces/api-response.dto';
import { UserGetListResponse, UserGetResponse } from './interfaces/response/get-user-response';


@Public()
@ApiTags('User')
@ApiSecurity('x-api-key')
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) { }


  //EXPUESTOS AL API
  @Public()
  @Post()
  @ApiOperation({ summary: 'Crear nuevo usuario', description: 'Registra un nuevo usuario en el sistema' })
  @ApiResponse({ status: 201, description: 'Usuario creado correctamente', type: UserCreateResponse })
  @ApiResponse({ status: 400, description: 'Los datos enviados son inválidos o incompletos', type: BadRequestResponse })
  @ApiResponse({ status: 401, description: 'API Key inválida o no proporcionada' })
  @ApiResponse({ status: 409, description: 'Ya existe un usuario registrado con ese correo electrónico', type: ConflictResponse })
  create(@Body() createUserDto: CreateUserDto) {
    return this.userService.create(createUserDto);
  }

  @Get()
  @ApiOperation({ summary: 'Obtener todos los usuarios' })
  @ApiQuery({ name: 'withSignature', required: false, type: Boolean, description: 'Incluir la firma del usuario' })
  @ApiResponse({ status: 200, description: 'Lista de usuarios obtenida correctamente', type: UserGetListResponse })
  @ApiResponse({ status: 401, description: 'API Key inválida o no proporcionada' })
  findAll(@Query('withSignature') withSignature?: string) {
    return this.userService.findAllActiveUsers(withSignature === 'true');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener un usuario' })
  @ApiParam({ name: 'id', description: 'Identificador único del usuario en formato UUID v4', format: 'uuid', example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa' })
  @ApiQuery({ name: 'withSignature', required: false, type: Boolean, description: 'Incluir la firma del usuario' })
  @ApiResponse({ status: 200, description: 'Usuario encontrado', type: UserGetResponse })
  @ApiResponse({ status: 401, description: 'API Key inválida o no proporcionada' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado', type: NotFoundResponse })
  findOne(@Param('id') id: string, @Query('withSignature') withSignature?: string) {
    return this.userService.findOneActiveUser(id, withSignature === 'true');
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar datos de un usuario' })
  @ApiParam({ name: 'id', description: 'Identificador único del usuario en formato UUID v4', format: 'uuid', example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa' })
  @ApiResponse({ status: 200, description: 'Usuario actualizado correctamente', type: UserCreateData })
  @ApiResponse({ status: 401, description: 'API Key inválida o no proporcionada' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado', type: NotFoundResponse })
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.userService.update(id, updateUserDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar usuario' })
  @ApiParam({ name: 'id', description: 'Identificador único del usuario en formato UUID v4', format: 'uuid', example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa' })
  @ApiResponse({ status: 200, description: 'Usuario eliminado correctamente', type: BaseResponse })
  @ApiResponse({ status: 401, description: 'API Key inválida o no proporcionada' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado', type: NotFoundResponse })
  remove(@Param('id') id: string) {
    return this.userService.remove(id);
  }
}
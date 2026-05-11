// NestJS core
import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';

// Swagger
import { ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';

// Auth
import { Public } from 'src/auth/decorators/public.decorator';

// Service
import { UserService } from './user.service';

// DTOs
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserCreateResponseDto } from './dto/response/create-user-response.dto';
import { ApiInvalidDataResponseDto, ApiNotFoundResponseDto, ApiResponseDto } from 'src/interfaces/api-response.dto';
import { UserGetListResponseDto, UserGetResponseDto } from './dto/response/get-user-response.dto';


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
  @ApiResponse({ status: 201, description: 'Usuario creado correctamente', type: UserCreateResponseDto })
  @ApiResponse({ status: 400, description: 'Los datos enviados son inválidos o incompletos', type: ApiInvalidDataResponseDto })
  @ApiResponse({ status: 401, description: 'API Key inválida o no proporcionada' })
  create(@Body() createUserDto: CreateUserDto) {
    return this.userService.create(createUserDto);
  }

  @Get()
  @ApiOperation({ summary: 'Obtener todos los usuarios' })
  @ApiResponse({ status: 200, description: 'Lista de usuarios obtenida correctamente', type: UserGetListResponseDto })
  @ApiResponse({ status: 401, description: 'API Key inválida o no proporcionada' })
  findAll() {
    return this.userService.findAllActiveUsers();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener un usuario' })
  @ApiParam({ name: 'id', description: 'Identificador único del usuario en formato UUID v4', format: 'uuid', example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa' })
  @ApiResponse({ status: 200, description: 'Usuario encontrado', type: UserGetResponseDto })
  @ApiResponse({ status: 401, description: 'API Key inválida o no proporcionada' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado', type: ApiNotFoundResponseDto })
  findOne(@Param('id') id: string) {
    return this.userService.findOneActiveUser(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar datos de un usuario' })
  @ApiParam({ name: 'id', description: 'Identificador único del usuario en formato UUID v4', format: 'uuid', example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa' })
  @ApiResponse({ status: 200, description: 'Usuario actualizado correctamente', type: UserCreateResponseDto })
  @ApiResponse({ status: 401, description: 'API Key inválida o no proporcionada' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado', type: ApiNotFoundResponseDto })
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.userService.update(id, updateUserDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar usuario' })
  @ApiParam({ name: 'id', description: 'Identificador único del usuario en formato UUID v4', format: 'uuid', example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa' })
  @ApiResponse({ status: 200, description: 'Usuario eliminado correctamente', type: ApiResponseDto })
  @ApiResponse({ status: 401, description: 'API Key inválida o no proporcionada' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado', type: ApiNotFoundResponseDto })
  remove(@Param('id') id: string) {
    return this.userService.remove(id);
  }
}
import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/auth/decorators/public.decorator';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserListResponseDto, UserResponseDto } from './dto/user-response.dto';
import { ApiInvalidDataResponseDto, ApiNotFoundResponseDto, ApiResponseDto } from 'src/interfaces/api-response.dto';

@ApiTags('User')
@ApiBearerAuth('access-token')
@Controller('user')
export class UserController {
  constructor(
    private readonly userService: UserService,
  ) {}

  @Public()
  @Post()
  @ApiOperation({ summary: 'Crear nuevo usuario' })
  @ApiResponse({ status: 201, description: 'Usuario creado correctamente', type: UserResponseDto })
  @ApiResponse({ status: 400, description: 'Datos de entrada inválidos', type: ApiInvalidDataResponseDto })
  create(@Body() createUserDto: CreateUserDto) {
    return this.userService.create(createUserDto);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Obtener todos los usuarios' })
  @ApiResponse({ status: 200, description: 'Lista de usuarios', type: UserListResponseDto })
  findAll() {
    return this.userService.findAllActiveUsers();
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Obtener usuario por UUID' })
  @ApiParam({ name: 'id', description: 'UUID del usuario', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Usuario encontrado', type: UserResponseDto })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado', type: ApiNotFoundResponseDto })
  findOne(@Param('id') id: string) {
    return this.userService.findOneActiveUser(id);
  }

  @Public()
  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar datos de un usuario' })
  @ApiParam({ name: 'id', description: 'UUID del usuario', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Usuario actualizado correctamente', type: UserResponseDto })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado', type: ApiNotFoundResponseDto })
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.userService.update(id, updateUserDto);
  }

  @Public()
  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar usuario por UUID' })
  @ApiParam({ name: 'id', description: 'UUID del usuario', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Usuario eliminado correctamente', type: ApiResponseDto })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado', type: ApiNotFoundResponseDto })
  remove(@Param('id') id: string) {
    return this.userService.remove(id);
  }
}

import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/auth/decorators/public.decorator';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';

@ApiTags('User')
@ApiBearerAuth('access-token')
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Public()
  @Post()
  @ApiOperation({ summary: 'Crear nuevo usuario' })
  @ApiResponse({ status: 201, description: 'Usuario creado correctamente', type: UserResponseDto })
  @ApiResponse({ status: 400, description: 'Datos de entrada inválidos' })
  create(@Body() createUserDto: CreateUserDto) {
    console.log('Creating user with data:', createUserDto);
    return this.userService.create(createUserDto);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Obtener todos los usuarios' })
  @ApiResponse({ status: 200, description: 'Lista de usuarios', type: [UserResponseDto] })
  findAll() {
    return this.userService.findAllActiveUsers();
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Obtener usuario por UUID' })
  @ApiParam({ name: 'id', description: 'UUID del usuario', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Usuario encontrado', type: UserResponseDto })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  findOne(@Param('id') id: string) {
    return this.userService.findOneActiveUser(id);
  }

  @Public()
  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar datos de un usuario' })
  @ApiParam({ name: 'id', description: 'UUID del usuario', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Usuario actualizado correctamente', type: UserResponseDto })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.userService.update(id, updateUserDto);
  }

  @Public()
  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar usuario por UUID' })
  @ApiParam({ name: 'id', description: 'UUID del usuario', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Usuario eliminado correctamente' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  remove(@Param('id') id: string) {
    return this.userService.remove(id);
  }
}

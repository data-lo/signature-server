import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipJwtAuth } from './decorators/skip-jwt-auth.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import {
  RegisterResponse,
  LoginResponse,
} from './interfaces/response/auth-response';
import { UserGetResponse } from '../user/interfaces/response/get-user-response';
import {
  UnauthorizedResponse,
  ConflictResponse,
} from '../interfaces/api-response.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @SkipJwtAuth()
  @Post('register')
  @ApiOperation({ summary: 'Registro público de usuario (self-service)' })
  @ApiResponse({ status: 201, type: RegisterResponse })
  @ApiResponse({ status: 409, type: ConflictResponse })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @SkipJwtAuth()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiOperation({ summary: 'Inicio de sesión' })
  @ApiResponse({ status: 200, type: LoginResponse })
  @ApiResponse({ status: 401, type: UnauthorizedResponse })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('logout')
  @ApiOperation({ summary: 'Cierra la sesión actual e invalida el token' })
  @ApiResponse({ status: 200, description: 'Sesión cerrada correctamente' })
  @ApiResponse({ status: 401, type: UnauthorizedResponse })
  logout(@CurrentUser() user: JwtPayload) {
    return this.authService.logout(user);
  }

  @ApiBearerAuth('access-token')
  @Get('me')
  @ApiOperation({ summary: 'Obtener los datos del usuario autenticado' })
  @ApiResponse({ status: 200, type: UserGetResponse })
  @ApiResponse({ status: 401, type: UnauthorizedResponse })
  me(@CurrentUser() user: JwtPayload) {
    return this.authService.me(user);
  }
}

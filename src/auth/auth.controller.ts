import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipJwtAuth } from './decorators/skip-jwt-auth.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import {
  RegisterResponse,
  LoginResponse,
  ResendOtpResponse,
} from './interfaces/response/auth-response';
import { UserGetResponse } from '../user/interfaces/response/get-user-response';
import {
  UnauthorizedResponse,
  ConflictResponse,
  ForbiddenResponse,
  NotFoundResponse,
} from '../interfaces/api-response.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Bug corregido: ThrottlerModule ya estaba configurado en app.module.ts (10 req/60s) pero
  // ThrottlerGuard nunca se aplicaba en ningún lado — la configuración daba una falsa
  // sensación de protección. Se aplica aquí explícitamente (no como APP_GUARD global, para no
  // arriesgar romper el uso normal del resto de la API sin haberlo probado contra tráfico
  // real) con un límite más estricto que el default, específico para frenar fuerza bruta.
  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register')
  @ApiOperation({ summary: 'Registro público de usuario (self-service)' })
  @ApiResponse({ status: 201, type: RegisterResponse })
  @ApiResponse({ status: 409, type: ConflictResponse })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiOperation({ summary: 'Inicio de sesión' })
  @ApiResponse({ status: 200, type: LoginResponse })
  @ApiResponse({ status: 401, type: UnauthorizedResponse })
  @ApiResponse({
    status: 403,
    type: ForbiddenResponse,
    description: 'La cuenta todavía no verifica su correo (pre-registro)',
  })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('verify-otp')
  @ApiOperation({
    summary: 'Verifica el OTP de registro y activa la cuenta (auto-login)',
  })
  @ApiResponse({ status: 200, type: LoginResponse })
  @ApiResponse({ status: 404, type: NotFoundResponse })
  @ApiResponse({ status: 409, type: ConflictResponse })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('resend-otp')
  @ApiOperation({ summary: 'Reenvía el OTP de registro pendiente' })
  @ApiResponse({ status: 200, type: ResendOtpResponse })
  @ApiResponse({ status: 404, type: NotFoundResponse })
  @ApiResponse({ status: 409, type: ConflictResponse })
  resendOtp(@Body() dto: ResendOtpDto) {
    return this.authService.resendOtp(dto);
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

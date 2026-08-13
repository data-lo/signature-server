import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
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
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { VerifyResetCodeDto } from './dto/verify-reset-code.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { UpdatePreRegistrationDto } from './dto/update-pre-registration.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import {
  RegisterResponse,
  LoginResponse,
  ForgotPasswordResponse,
  VerifyResetCodeResponse,
  ResetPasswordResponse,
  ResendOtpResponse,
  UpdatePreRegistrationResponse,
} from './interfaces/response/auth-response';
import { UserGetResponse } from '../user/interfaces/response/get-user-response';
import {
  UnauthorizedResponse,
  ConflictResponse,
  BadRequestResponse,
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

  // Mismo límite que login: la contraseña del pre-registro es lo único que autoriza el cambio,
  // así que este endpoint también hay que protegerlo de fuerza bruta.
  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Patch('pre-registration')
  @ApiOperation({
    summary:
      'Corrige los datos de un registro que aún no verifica su correo (público, autorizado con la contraseña del propio registro)',
    description:
      'Pensado para el error de dedo en el correo, que dejaba la cuenta imposible de activar: el código se enviaba a una dirección inexistente y volver a registrarse tampoco servía, porque el CURP ya estaba tomado por ese mismo pre-registro. Si el correo cambia, se emite y envía un código nuevo a la dirección corregida.',
  })
  @ApiResponse({ status: 200, type: UpdatePreRegistrationResponse })
  @ApiResponse({
    status: 401,
    type: UnauthorizedResponse,
    description:
      'No hay un registro pendiente con ese correo, o la contraseña no coincide (mismo mensaje en ambos casos, anti-enumeración)',
  })
  @ApiResponse({
    status: 409,
    type: ConflictResponse,
    description:
      'El correo ya fue verificado, o el nuevo correo/CURP/RFC ya pertenece a otro usuario',
  })
  updatePreRegistration(@Body() dto: UpdatePreRegistrationDto) {
    return this.authService.updatePreRegistration(dto);
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

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  @ApiOperation({
    summary:
      'Solicita un código OTP de recuperación de contraseña (mensaje genérico siempre, anti-enumeración)',
  })
  @ApiResponse({ status: 200, type: ForgotPasswordResponse })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('verify-reset-code')
  @ApiOperation({ summary: 'Valida el OTP de recuperación de contraseña' })
  @ApiResponse({ status: 200, type: VerifyResetCodeResponse })
  @ApiResponse({ status: 400, type: BadRequestResponse })
  verifyResetCode(@Body() dto: VerifyResetCodeDto) {
    return this.authService.verifyResetCode(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  @ApiOperation({
    summary:
      'Establece una nueva contraseña usando el resetToken de /auth/verify-reset-code',
  })
  @ApiResponse({ status: 200, type: ResetPasswordResponse })
  @ApiResponse({ status: 401, type: UnauthorizedResponse })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
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

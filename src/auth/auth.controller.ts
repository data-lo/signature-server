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
import { ApiTags } from '@nestjs/swagger';
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

// Docs
import { ApiRegister } from './docs/api-register.docs';
import { ApiLogin } from './docs/api-login.docs';
import { ApiVerifyOtp } from './docs/api-verify-otp.docs';
import { ApiUpdatePreRegistration } from './docs/api-update-pre-registration.docs';
import { ApiResendOtp } from './docs/api-resend-otp.docs';
import { ApiForgotPassword } from './docs/api-forgot-password.docs';
import { ApiVerifyResetCode } from './docs/api-verify-reset-code.docs';
import { ApiResetPassword } from './docs/api-reset-password.docs';
import { ApiLogout } from './docs/api-logout.docs';
import { ApiGetAuthenticatedUser } from './docs/api-get-authenticated-user.docs';

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
  @ApiRegister()
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiLogin()
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('verify-otp')
  @ApiVerifyOtp()
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
  @ApiUpdatePreRegistration()
  updatePreRegistration(@Body() dto: UpdatePreRegistrationDto) {
    return this.authService.updatePreRegistration(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('resend-otp')
  @ApiResendOtp()
  resendOtp(@Body() dto: ResendOtpDto) {
    return this.authService.resendOtp(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  @ApiForgotPassword()
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('verify-reset-code')
  @ApiVerifyResetCode()
  verifyResetCode(@Body() dto: VerifyResetCodeDto) {
    return this.authService.verifyResetCode(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  @ApiResetPassword()
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('logout')
  @ApiLogout()
  logout(@CurrentUser() user: JwtPayload) {
    return this.authService.logout(user);
  }

  @Get('me')
  @ApiGetAuthenticatedUser()
  me(@CurrentUser() user: JwtPayload) {
    return this.authService.me(user);
  }
}

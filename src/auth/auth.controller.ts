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
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { VerifyResetCodeDto } from './dto/verify-reset-code.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { UpdatePreRegistrationDto } from './dto/update-pre-registration.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';

import { RegisterUseCase } from './applications/register.use-case';
import { LoginUseCase } from './applications/login.use-case';
import { VerifyRegistrationOtpUseCase } from './applications/verify-registration-otp.use-case';
import { UpdatePreRegistrationUseCase } from './applications/update-pre-registration.use-case';
import { ResendRegistrationOtpUseCase } from './applications/resend-registration-otp.use-case';
import { RequestPasswordResetUseCase } from './applications/request-password-reset.use-case';
import { VerifyPasswordResetCodeUseCase } from './applications/verify-password-reset-code.use-case';
import { ResetPasswordUseCase } from './applications/reset-password.use-case';
import { LogoutUseCase } from './applications/logout.use-case';
import { GetAuthenticatedUserUseCase } from './applications/get-authenticated-user.use-case';

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
  constructor(
    private readonly registerUser: RegisterUseCase,
    private readonly loginUser: LoginUseCase,
    private readonly verifyRegistrationOtp: VerifyRegistrationOtpUseCase,
    private readonly updatePreRegistrationData: UpdatePreRegistrationUseCase,
    private readonly resendRegistrationOtp: ResendRegistrationOtpUseCase,
    private readonly requestPasswordReset: RequestPasswordResetUseCase,
    private readonly verifyPasswordResetCode: VerifyPasswordResetCodeUseCase,
    private readonly resetPasswordUseCase: ResetPasswordUseCase,
    private readonly logoutUser: LogoutUseCase,
    private readonly getAuthenticatedUser: GetAuthenticatedUserUseCase,
  ) {}

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
    return this.registerUser.execute(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiLogin()
  login(@Body() dto: LoginDto) {
    return this.loginUser.execute(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('verify-otp')
  @ApiVerifyOtp()
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.verifyRegistrationOtp.execute(dto);
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
    return this.updatePreRegistrationData.execute(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('resend-otp')
  @ApiResendOtp()
  resendOtp(@Body() dto: ResendOtpDto) {
    return this.resendRegistrationOtp.execute(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  @ApiForgotPassword()
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.requestPasswordReset.execute(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('verify-reset-code')
  @ApiVerifyResetCode()
  verifyResetCode(@Body() dto: VerifyResetCodeDto) {
    return this.verifyPasswordResetCode.execute(dto);
  }

  @SkipJwtAuth()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  @ApiResetPassword()
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.resetPasswordUseCase.execute(dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('logout')
  @ApiLogout()
  logout(@CurrentUser() user: JwtPayload) {
    return this.logoutUser.execute(user);
  }

  @Get('me')
  @ApiGetAuthenticatedUser()
  me(@CurrentUser() user: JwtPayload) {
    return this.getAuthenticatedUser.execute(user);
  }
}

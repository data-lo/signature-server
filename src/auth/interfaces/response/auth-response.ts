import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';
import { UserCreateData } from '../../../user/interfaces/response/user-create-response';
import { SignupPendingVerificationData } from '../../../user/interfaces/response/signup-pending-verification-response';

export class RegisterResponse extends BaseResponse<SignupPendingVerificationData> {
  @ApiProperty({
    type: SignupPendingVerificationData,
    description: 'Datos del pre-registro pendiente de verificación',
  })
  data: SignupPendingVerificationData;
}

export class ResendOtpResponseData {
  @ApiProperty({
    example: 'juan.perez@empresa.com',
    description: 'Correo real asociado al pre-registro',
  })
  email: string;

  @ApiProperty({
    example: 'j***z@empresa.com',
    description: 'Correo enmascarado, para mostrarse en pantalla',
  })
  maskedEmail: string;
}

export class ResendOtpResponse extends BaseResponse<ResendOtpResponseData> {
  @ApiProperty({
    type: ResendOtpResponseData,
    description: 'Datos del reenvío de OTP',
  })
  data: ResendOtpResponseData;
}

export class LoginResponseData {
  @ApiProperty({
    type: UserCreateData,
    description: 'Datos del usuario autenticado',
  })
  user: UserCreateData;

  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIs...',
    description: 'Token JWT de la sesión',
  })
  token: string;
}

export class LoginResponse extends BaseResponse<LoginResponseData> {
  @ApiProperty({
    type: LoginResponseData,
    description: 'Datos de la sesión iniciada',
  })
  data: LoginResponseData;
}

export class ForgotPasswordResponse extends BaseResponse<null> {
  @ApiProperty({
    example: null,
    description:
      'Sin datos — la respuesta es siempre el mismo mensaje genérico',
  })
  data: null;
}

export class VerifyResetCodeResponseData {
  @ApiProperty({
    description:
      'Token de corta duración (10 min) para usar en /auth/reset-password',
  })
  resetToken: string;
}

export class VerifyResetCodeResponse extends BaseResponse<VerifyResetCodeResponseData> {
  @ApiProperty({
    type: VerifyResetCodeResponseData,
    description: 'Datos de la verificación del código',
  })
  data: VerifyResetCodeResponseData;
}

export class ResetPasswordResponse extends BaseResponse<null> {
  @ApiProperty({
    example: null,
    description: 'Sin datos adicionales',
  })
  data: null;
}

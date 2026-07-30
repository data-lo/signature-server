import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';
import { UserCreateData } from '../../../user/interfaces/response/user-create-response';

export class RegisterResponse extends BaseResponse<UserCreateData> {
  @ApiProperty({
    type: UserCreateData,
    description: 'Datos del usuario registrado',
  })
  data: UserCreateData;
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

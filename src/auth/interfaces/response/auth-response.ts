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

import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';

/**
 * Respuesta de `POST /auth/register` desde que existe el flujo de pre-registro + OTP (ver
 * historia "Auth: Flujo de Pre-registro, Verificación OTP y Control por CURP"): el registro ya
 * no crea una cuenta lista para usarse — siempre deja al usuario pendiente de verificar su
 * correo, sea porque se acaba de crear la pre-cuenta o porque ya existía una pendiente para ese
 * CURP (ver `isNewPreRegistration`).
 */
export class SignupPendingVerificationData {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID del usuario (pre-cuenta) pendiente de verificación',
    format: 'uuid',
  })
  userId: string;

  @ApiProperty({
    example: 'juan.perez@empresa.com',
    description:
      'Correo real asociado al pre-registro, necesario para llamar a /auth/verify-otp y /auth/resend-otp',
  })
  email: string;

  @ApiProperty({
    example: 'j***z@empresa.com',
    description: 'Correo enmascarado, para mostrarse en la pantalla de OTP',
  })
  maskedEmail: string;

  @ApiProperty({
    example: true,
    description:
      'true si se creó una pre-cuenta nueva; false si ya existía una pendiente para ese CURP y solo se reenvió el OTP',
  })
  isNewPreRegistration: boolean;
}

export class SignupPendingVerificationResponse extends BaseResponse<SignupPendingVerificationData> {
  @ApiProperty({
    type: SignupPendingVerificationData,
    description: 'Datos del pre-registro pendiente de verificación',
  })
  data: SignupPendingVerificationData;
}

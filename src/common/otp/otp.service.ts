import { Injectable } from '@nestjs/common';
import { authenticator } from '@otplib/preset-default';

@Injectable()
export class OTPService {
  /**
   * Genera un código OTP de 6 dígitos con una validez de 15 minutos (900 segundos).
   * @returns El código OTP generado como una cadena de texto.
   */
  generate(): string {
    const secret = authenticator.generateSecret();
    const code = authenticator.generate(secret);
    return code;
  }

  /**
   * Verifica si el token proporcionado coincide con el código OTP almacenado.
   * @param token El código OTP que se va a verificar.
   * @param storedCode El código OTP almacenado que se espera que coincida con el token.
   * @returns true si el token es válido, false en caso contrario.
   */
  verify(token: string, storedCode: string): boolean {
    return storedCode === token;
  }
}

import { TOTP } from 'otplib';
import { Injectable } from '@nestjs/common';

@Injectable()
export class OTPService {
  private readonly totp: TOTP;

  constructor() {
    this.totp = new TOTP({ digits: 6, period: 900 });
  }

  /**
   * Genera un código OTP de 6 dígitos con una validez de 15 minutos (900 segundos).
   * @returns El código OTP generado como una cadena de texto.
   */
  async generate(): Promise<string> {
    const secret = this.totp.generateSecret();
    return this.totp.generate({ secret });
  }

  /**
   * Verifica si el token proporcionado coincide con el código OTP almacenado.
   * @param token El código OTP que se desea verificar.
   * @param storedCode El código OTP almacenado que se espera que coincida con el token.
   * @returns true si el token es válido, false en caso contrario.
   */
  verify(token: string, storedCode: string): boolean {
    return storedCode === token;
  }
}

import { TOTP } from 'otplib';

const otp = new TOTP({
    digits: 6, // Número de dígitos en el código OTP,
    period: 900, // Intervalo de tiempo en segundos para la validez del código OTP
});

/**
 * Genera un nuevo secreto OTP seguro (base32)
 */
export function generateOtpSecret(): string {
  return otp.generateSecret();
}

/**
 * Genera un código OTP basado en el secret proporcionado
 */
export function generateOtpCode(secret: string): string {
  // Aquí pasas el secret directamente como string
  // @ts-ignore
  return otp.generate(secret);
}

/**
 * Verifica si el código OTP es válido
 */
export function verifyOtpCode(secret: string, token: string): boolean {
  // @ts-ignore
  const result =  otp.verify(token, secret);
  // @ts-ignore
  return result;
}
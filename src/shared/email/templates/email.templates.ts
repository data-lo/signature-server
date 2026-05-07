export const welcomeTemplate = (userName: string): string => `
  <h1>Bienvenido, ${userName}!</h1>
  <p>Tu cuenta ha sido creada exitosamente en Signature Server.</p>
  <p>Puedes comenzar a usar nuestros servicios de firma digital.</p>
`;

export const passwordResetTemplate = (resetUrl: string): string => `
  <h1>Restablecer contraseña</h1>
  <p>Haz clic en el siguiente enlace para restablecer tu contraseña:</p>
  <a href="${resetUrl}">Restablecer contraseña</a>
  <p>Este enlace expirará en 1 hora.</p>
`;

export const documentPendingTemplate = (
  documentName: string,
  signerName: string,
): string => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; padding: 40px;">

    <h2 style="color: #333333;">Documento enviado para autorización</h2>

    <p style="color: #555555;">Hola <strong>${signerName}</strong>,</p>

    <p style="color: #555555;">
      El siguiente documento ha sido enviado para tu autorización:
    </p>

    <div style="background-color: #f4faf4; border-left: 4px solid #2E7D32; padding: 16px; margin: 24px 0;">
      <p style="margin: 0; color: #333333;"><strong>${documentName}</strong></p>
    </div>

    <p style="color: #555555;">
      Será necesario el código de verificación que enviaremos a tu correo para completar la firma.
    </p>

    <p style="color: #999999; font-size: 12px;">
      Si no esperabas este mensaje, por favor contáctanos.
    </p>

  </div>
</body>
</html>
`;

export const signatureRequestTemplate = (
  documentName: string,
  signerName: string,
  verificationCode: string,
): string => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; padding: 40px;">
    
    <h2 style="color: #333333;">Solicitud de firma de documento</h2>
    
    <p style="color: #555555;">Hola <strong>${signerName}</strong>,</p>
    
    <p style="color: #555555;">
      Se ha solicitado tu firma para el siguiente documento:
    </p>

    <div style="background-color: #f4faf4; border-left: 4px solid #2E7D32; padding: 16px; margin: 24px 0;">
      <p style="margin: 0; color: #333333;"><strong>${documentName}</strong></p>
    </div>

    <p style="color: #555555;">
      Usa el siguiente código para completar la firma:
    </p>

    <div style="text-align: center; margin: 32px 0;">
      <span style="
        font-size: 32px;
        font-weight: bold;
        letter-spacing: 8px;
        color: #2E7D32;
        background-color: #f0faf0;
        padding: 16px 32px;
        border-radius: 8px;
      ">
        ${verificationCode}
      </span>
    </div>

    <p style="color: #999999; font-size: 12px;">
      Este código es de un solo uso y expirará en 15 minutos. 
      Si no solicitaste esta firma, ignora este mensaje.
    </p>

  </div>
</body>
</html>
`;
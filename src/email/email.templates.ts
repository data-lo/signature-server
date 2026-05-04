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

export const signatureNotificationTemplate = (documentName: string, signerName: string): string => `
  <h1>Documento pendiente de firma</h1>
  <p>El documento "${documentName}" está listo para tu firma.</p>
  <p>Firmado por: ${signerName}</p>
  <p>Por favor, accede a tu cuenta para completar el proceso de firma.</p>
`;

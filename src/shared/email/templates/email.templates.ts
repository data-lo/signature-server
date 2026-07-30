export const documentPendingTemplate = (
  signerName: string,
  creatorEmail: string,
  documentName: string,
  documentUrl: string,
  allDocumentsUrl: string,
): string => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px; margin: 0;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; padding: 40px;">

    <h2 style="color: #333333; margin-top: 0;">Firma de documentos</h2>

    <p style="color: #555555;">Hola <strong>${signerName}</strong>:</p>

    <p style="color: #555555;">
      <a href="mailto:${creatorEmail}" style="color: #2E7D32;">${creatorEmail}</a>
      ha solicitado que firmes el documento llamado <strong>${documentName}</strong>.
    </p>

    <table role="presentation" style="margin: 32px 0;">
      <tr>
        <td style="padding-right: 12px;">
          <a href="${documentUrl}" style="display: inline-block; background-color: #2E7D32; color: #ffffff; text-decoration: none; font-weight: bold; padding: 14px 24px; border-radius: 6px;">
            Ver este documento
          </a>
        </td>
        <td>
          <a href="${allDocumentsUrl}" style="display: inline-block; background-color: #ffffff; color: #2E7D32; text-decoration: none; font-weight: bold; padding: 13px 24px; border-radius: 6px; border: 1px solid #2E7D32;">
            Ver todo a firmar
          </a>
        </td>
      </tr>
    </table>

    <p style="color: #555555; font-size: 13px;">
      O copia este enlace y pégalo en tu navegador:
      <a href="${documentUrl}" style="color: #2E7D32;">${documentUrl}</a>
    </p>

    <p style="color: #999999; font-size: 12px;">
      Si no esperabas este mensaje, por favor contáctanos.
    </p>

  </div>
</body>
</html>
`;

export const documentSignedTemplate = (
  participantName: string,
  documentName: string,
): string => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px; margin: 0;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; padding: 40px;">

    <h2 style="color: #2E7D32; margin-top: 0;">Documento firmado exitosamente</h2>

    <p style="color: #555555;">Hola <strong>${participantName}</strong>,</p>

    <p style="color: #555555;">
      El documento <strong>${documentName}</strong> ha sido firmado por todos los participantes.
      Adjuntamos el comprobante en formato PDF.
    </p>

    <p style="color: #999999; font-size: 12px;">
      Este correo es tu comprobante de que el proceso de firma se completó correctamente.
    </p>

  </div>
</body>
</html>
`;

/** Ver documentSignedTemplate: mismo evento, pero dirigido a quien creó el documento y con la lista de firmantes (que un participante ya conoce, pero el creador quiere ver de un vistazo). */
export const documentCompletedForCreatorTemplate = (
  creatorName: string,
  documentName: string,
  signerNames: string[],
): string => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px; margin: 0;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; padding: 40px;">

    <h2 style="color: #2E7D32; margin-top: 0;">Documento firmado exitosamente</h2>

    <p style="color: #555555;">Hola <strong>${creatorName}</strong>,</p>

    <p style="color: #555555;">
      El documento <strong>${documentName}</strong> que enviaste a firmar ha sido firmado por
      todos los participantes. Adjuntamos el comprobante en formato PDF.
    </p>

    <p style="color: #555555; margin-bottom: 8px;">Firmantes:</p>
    <ul style="color: #333333; padding-left: 20px; margin-top: 0;">
      ${signerNames.map((name) => `<li>${name}</li>`).join('\n      ')}
    </ul>

    <p style="color: #999999; font-size: 12px;">
      Este correo es tu comprobante de que el proceso de firma se completó correctamente.
    </p>

  </div>
</body>
</html>
`;

export const documentRejectedTemplate = (
  creatorName: string,
  rejecterName: string,
  documentName: string,
  reason: string,
): string => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px; margin: 0;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; padding: 40px;">

    <h2 style="color: #E65100; margin-top: 0;">Documento rechazado</h2>

    <p style="color: #555555;">Hola <strong>${creatorName}</strong>,</p>

    <p style="color: #555555;">
      <strong>${rejecterName}</strong> rechazó el documento <strong>${documentName}</strong> que enviaste a firmar.
    </p>

    <div style="background-color: #fff8f0; border-left: 4px solid #E65100; padding: 16px; margin: 24px 0;">
      <p style="margin: 0; color: #333333;">${reason}</p>
    </div>

  </div>
</body>
</html>
`;

export const documentCancelledTemplate = (
  participantName: string,
  documentName: string,
): string => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px; margin: 0;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; padding: 40px;">

    <h2 style="color: #C62828; margin-top: 0;">Documento cancelado</h2>

    <p style="color: #555555;">Hola <strong>${participantName}</strong>,</p>

    <p style="color: #555555;">
      El documento <strong>${documentName}</strong> fue cancelado. Ya no es necesario realizar ninguna acción sobre él.
    </p>

  </div>
</body>
</html>
`;

export const organizationInvitationTemplate = (
  organizationName: string,
  joinUrl: string,
): string => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px; margin: 0;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; padding: 40px;">

    <h2 style="color: #2E7D32; margin-top: 0;">Te invitaron a una organización</h2>

    <p style="color: #555555;">
      Has sido invitado a unirte a <strong>${organizationName}</strong> en Firmalo.
    </p>

    <table role="presentation" style="margin: 32px 0;">
      <tr>
        <td>
          <a href="${joinUrl}" style="display: inline-block; background-color: #2E7D32; color: #ffffff; text-decoration: none; font-weight: bold; padding: 14px 24px; border-radius: 6px;">
            Unirme a ${organizationName}
          </a>
        </td>
      </tr>
    </table>

    <p style="color: #555555; font-size: 13px;">
      O copia este enlace y pégalo en tu navegador:
      <a href="${joinUrl}" style="color: #2E7D32;">${joinUrl}</a>
    </p>

    <p style="color: #999999; font-size: 12px;">
      Si no esperabas este mensaje, puedes ignorarlo.
    </p>

  </div>
</body>
</html>
`;

export const verificationCodeTemplate = (
  documentName: string,
  code: string,
): string => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px; margin: 0;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; padding: 40px;">

    <h2 style="color: #333333; margin-top: 0;">Código de verificación</h2>

    <p style="color: #555555;">
      Tu código de verificación para firmar <strong>${documentName}</strong> es:
    </p>

    <div style="background-color: #f4f4f4; border-radius: 6px; padding: 20px; margin: 24px 0; text-align: center;">
      <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #2E7D32;">${code}</span>
    </div>

    <p style="color: #555555; font-size: 13px;">
      Este código vence en 15 minutos.
    </p>

    <p style="color: #999999; font-size: 12px;">
      Si no esperabas este mensaje, por favor contáctanos.
    </p>

  </div>
</body>
</html>
`;

export const passwordResetOtpTemplate = (code: string): string => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px; margin: 0;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; padding: 40px;">

    <h2 style="color: #333333; margin-top: 0;">Recupera tu contraseña</h2>

    <p style="color: #555555;">
      Recibimos una solicitud para restablecer tu contraseña. Usa el siguiente código para continuar:
    </p>

    <div style="background-color: #f4f4f4; border-radius: 6px; padding: 20px; margin: 24px 0; text-align: center;">
      <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #2E7D32;">${code}</span>
    </div>

    <p style="color: #555555; font-size: 13px;">
      Este código vence en 15 minutos.
    </p>

    <p style="color: #999999; font-size: 12px;">
      Si no solicitaste este cambio, ignora este correo — tu contraseña seguirá siendo la misma.
    </p>

  </div>
</body>
</html>
`;

export const registrationOtpTemplate = (code: string): string => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px; margin: 0;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; padding: 40px;">

    <h2 style="color: #333333; margin-top: 0;">Verifica tu correo</h2>

    <p style="color: #555555;">
      Gracias por registrarte. Usa el siguiente código para verificar tu correo y activar tu cuenta:
    </p>

    <div style="background-color: #f4f4f4; border-radius: 6px; padding: 20px; margin: 24px 0; text-align: center;">
      <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #2E7D32;">${code}</span>
    </div>

    <p style="color: #555555; font-size: 13px;">
      Este código vence en 15 minutos.
    </p>

    <p style="color: #999999; font-size: 12px;">
      Si no esperabas este mensaje, por favor contáctanos.
    </p>

  </div>
</body>
</html>
`;

export const documentInvitationTemplate = (
  signerName: string,
  documentName: string,
  accessUrl: string,
): string => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px; margin: 0;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; padding: 40px;">

    <h2 style="color: #333333; margin-top: 0;">Te invitaron a firmar un documento</h2>

    <p style="color: #555555;">Hola <strong>${signerName}</strong>:</p>

    <p style="color: #555555;">
      Te invitaron a firmar el documento <strong>${documentName}</strong> con Firma Digital
      Simple. Para continuar, inicia sesión o crea tu cuenta en Firmalo con este mismo correo.
    </p>

    <table role="presentation" style="margin: 32px 0;">
      <tr>
        <td>
          <a href="${accessUrl}" style="display: inline-block; background-color: #2E7D32; color: #ffffff; text-decoration: none; font-weight: bold; padding: 14px 24px; border-radius: 6px;">
            Acceder para firmar
          </a>
        </td>
      </tr>
    </table>

    <p style="color: #555555; font-size: 13px;">
      O copia este enlace y pégalo en tu navegador:
      <a href="${accessUrl}" style="color: #2E7D32;">${accessUrl}</a>
    </p>

    <p style="color: #999999; font-size: 12px;">
      Si no esperabas este mensaje, puedes ignorarlo.
    </p>

  </div>
</body>
</html>
`;

export const documentCancellationPendingTemplate = (
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

    <h2 style="color: #C62828;">Solicitud de cancelación de documento</h2>

    <p style="color: #555555;">Hola <strong>${signerName}</strong>,</p>

    <p style="color: #555555;">
      Se ha solicitado la cancelación del siguiente documento que contiene tu firma:
    </p>

    <div style="background-color: #fff5f5; border-left: 4px solid #C62828; padding: 16px; margin: 24px 0;">
      <p style="margin: 0; color: #333333;"><strong>${documentName}</strong></p>
    </div>

    <p style="color: #999999; font-size: 12px;">
      Si no esperabas este mensaje, por favor contáctanos de inmediato.
    </p>

  </div>
</body>
</html>
`;

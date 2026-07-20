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

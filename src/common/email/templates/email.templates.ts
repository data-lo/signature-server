const FIRMALO_LOGO_URL = 'https://firmalo.com.mx/brand/firmalo-logo.svg';
const PRIVACY_NOTICE_URL = 'https://firmalo.com.mx/privacidad';

const colors = {
  primary: '#2e4677',
  link: '#155dfc',
  background: '#f3f4f6',
  border: '#e5e7eb',
  text: '#364153',
  muted: '#6b7280',
  white: '#ffffff',
  // Los avisos de cancelación y rechazo conservan sus colores de alerta: no deben leerse como un
  // correo más de la marca.
  danger: '#C62828',
  dangerSoft: '#fff5f5',
  warning: '#E65100',
  warningSoft: '#fff8f0',
} as const;

type Tone = 'primary' | 'danger' | 'warning';

const toneColor: Record<Tone, string> = {
  primary: colors.primary,
  danger: colors.danger,
  warning: colors.warning,
};

const paragraph = (content: string): string =>
  `<p style="margin: 0 0 16px; color: ${colors.text}; font-size: 15px; line-height: 24px;">${content}</p>`;

const note = (content: string): string =>
  `<p style="margin: 0 0 12px; color: ${colors.muted}; font-size: 12px; line-height: 18px;">${content}</p>`;

const link = (href: string, label: string = href): string =>
  `<a href="${href}" style="color: ${colors.link}; text-decoration: underline; word-break: break-all;">${label}</a>`;

const primaryButton = (href: string, label: string): string => `
<a href="${href}" style="display: inline-block; background-color: ${colors.primary}; color: ${colors.white}; text-decoration: none; font-weight: bold; font-size: 15px; padding: 14px 24px; border-radius: 6px;">${label}</a>`;

const secondaryButton = (href: string, label: string): string => `
<a href="${href}" style="display: inline-block; background-color: ${colors.white}; color: ${colors.primary}; text-decoration: none; font-weight: bold; font-size: 15px; padding: 13px 23px; border-radius: 6px; border: 1px solid ${colors.primary};">${label}</a>`;

const buttons = (...items: string[]): string => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 28px 0;">
  <tr>
    ${items.map((item) => `<td style="padding: 0 12px 8px 0;">${item}</td>`).join('\n    ')}
  </tr>
</table>`;

const linkFallback = (href: string): string => `
<p style="margin: 0 0 16px; color: ${colors.muted}; font-size: 13px; line-height: 20px;">
  O copia este enlace y pégalo en tu navegador:<br>${link(href)}
</p>`;

const codeBox = (code: string): string => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
  <tr>
    <td align="center" style="background-color: ${colors.background}; border: 1px solid ${colors.border}; border-radius: 8px; padding: 20px;">
      <span style="font-family: 'Courier New', Courier, monospace; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: ${colors.primary};">${code}</span>
    </td>
  </tr>
</table>`;

const calloutBox = (
  content: string,
  tone: Exclude<Tone, 'primary'>,
): string => {
  const [border, background] =
    tone === 'danger'
      ? [colors.danger, colors.dangerSoft]
      : [colors.warning, colors.warningSoft];
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
  <tr>
    <td style="background-color: ${background}; border-left: 4px solid ${border}; padding: 16px; color: ${colors.text}; font-size: 15px; line-height: 22px;">${content}</td>
  </tr>
</table>`;
};

const legalNotice = (content: string): string => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0 0;">
  <tr>
    <td style="border-top: 1px solid ${colors.border}; padding-top: 16px; color: ${colors.muted}; font-size: 11px; line-height: 17px; text-align: justify;">${content}</td>
  </tr>
</table>`;

/**
 * Estructura común de todos los correos: logo de Firmalo, franja con el color del aviso, título,
 * cuerpo y pie con el aviso de privacidad. Está hecha con tablas y estilos en línea porque es lo
 * único que respetan de forma consistente los clientes de correo.
 */
const emailLayout = ({
  title,
  body,
  tone = 'primary',
}: {
  title: string;
  body: string;
  tone?: Tone;
}): string => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${colors.background}; font-family: Arial, Helvetica, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${colors.background};">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: ${colors.white}; border: 1px solid ${colors.border}; border-radius: 8px; overflow: hidden;">
          <tr>
            <td style="height: 4px; line-height: 4px; font-size: 0; background-color: ${toneColor[tone]};">&nbsp;</td>
          </tr>
          <tr>
            <td align="left" style="padding: 28px 40px 20px; border-bottom: 1px solid ${colors.border};">
              <img src="${FIRMALO_LOGO_URL}" alt="Firmalo" width="140" style="display: block; width: 140px; max-width: 140px; height: auto; border: 0; outline: none; text-decoration: none;">
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 40px 36px;">
              <h1 style="margin: 0 0 20px; color: ${toneColor[tone]}; font-size: 22px; line-height: 30px; font-weight: bold;">${title}</h1>
              ${body}
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px;">
          <tr>
            <td align="center" style="padding: 20px 16px 0; color: ${colors.muted}; font-size: 12px; line-height: 18px;">
              Consulta nuestro ${link(PRIVACY_NOTICE_URL, 'Aviso de Privacidad')} para conocer cómo tratamos tus datos personales.<br>
              © Firmalo · ${link('https://firmalo.com.mx', 'firmalo.com.mx')}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

export const documentPendingTemplate = (
  signerName: string,
  creatorEmail: string,
  documentName: string,
  documentUrl: string,
  allDocumentsUrl: string,
): string =>
  emailLayout({
    title: 'Firma de documentos',
    body: `
      ${paragraph(`Hola <strong>${signerName}</strong>:`)}
      ${paragraph(`${link(`mailto:${creatorEmail}`, creatorEmail)} ha solicitado que firmes el documento llamado <strong>${documentName}</strong>.`)}
      ${buttons(primaryButton(documentUrl, 'Ver este documento'), secondaryButton(allDocumentsUrl, 'Ver todo a firmar'))}
      ${linkFallback(documentUrl)}
      ${note('Si no esperabas este mensaje, por favor contáctanos.')}
    `,
  });

export const documentSignedTemplate = (
  participantName: string,
  documentName: string,
): string =>
  emailLayout({
    title: 'Documento firmado exitosamente',
    body: `
      ${paragraph(`Hola <strong>${participantName}</strong>:`)}
      ${paragraph(`El documento <strong>${documentName}</strong> ha sido firmado por todos los participantes. Adjuntamos el comprobante en formato PDF.`)}
      ${note('Este correo es tu comprobante de que el proceso de firma se completó correctamente.')}
    `,
  });

/** Ver documentSignedTemplate: mismo evento, pero dirigido a quien creó el documento y con la lista de firmantes (que un participante ya conoce, pero el creador quiere ver de un vistazo). */
export const documentCompletedForCreatorTemplate = (
  creatorName: string,
  documentName: string,
  signerNames: string[],
): string =>
  emailLayout({
    title: 'Documento firmado exitosamente',
    body: `
      ${paragraph(`Hola <strong>${creatorName}</strong>:`)}
      ${paragraph(`El documento <strong>${documentName}</strong> que enviaste a firmar ha sido firmado por todos los participantes. Adjuntamos el comprobante en formato PDF.`)}
      <p style="margin: 0 0 8px; color: ${colors.text}; font-size: 15px; font-weight: bold;">Firmantes:</p>
      <ul style="margin: 0 0 20px; padding-left: 20px; color: ${colors.text}; font-size: 15px; line-height: 24px;">
        ${signerNames.map((name) => `<li>${name}</li>`).join('\n        ')}
      </ul>
      ${note('Este correo es tu comprobante de que el proceso de firma se completó correctamente.')}
    `,
  });

export const documentRejectedTemplate = (
  creatorName: string,
  rejecterName: string,
  documentName: string,
  reason: string,
): string =>
  emailLayout({
    title: 'Documento rechazado',
    tone: 'warning',
    body: `
      ${paragraph(`Hola <strong>${creatorName}</strong>:`)}
      ${paragraph(`<strong>${rejecterName}</strong> rechazó el documento <strong>${documentName}</strong> que enviaste a firmar.`)}
      ${calloutBox(reason, 'warning')}
    `,
  });

/**
 * Versión para el testigo del aviso de rechazo: el de `documentRejectedTemplate` le habla a quien
 * envió el documento ("que enviaste a firmar"), que no es el caso del testigo.
 */
export const documentRejectedToWitnessTemplate = (
  witnessName: string,
  rejecterName: string,
  documentName: string,
  reason: string,
): string =>
  emailLayout({
    title: 'Documento rechazado',
    tone: 'warning',
    body: `
      ${paragraph(`Hola <strong>${witnessName}</strong>:`)}
      ${paragraph(`<strong>${rejecterName}</strong> rechazó el documento <strong>${documentName}</strong>, del que eres testigo. El proceso de firma se detuvo y no es necesario que hagas nada.`)}
      ${calloutBox(reason, 'warning')}
    `,
  });

export const documentCancelledTemplate = (
  participantName: string,
  documentName: string,
): string =>
  emailLayout({
    title: 'Documento cancelado',
    tone: 'danger',
    body: `
      ${paragraph(`Hola <strong>${participantName}</strong>:`)}
      ${paragraph(`El documento <strong>${documentName}</strong> fue cancelado. Ya no es necesario realizar ninguna acción sobre él.`)}
    `,
  });

export const organizationInvitationTemplate = (
  organizationName: string,
  joinUrl: string,
): string =>
  emailLayout({
    title: 'Te invitaron a una organización',
    body: `
      ${paragraph(`Has sido invitado a unirte a <strong>${organizationName}</strong> en Firmalo.`)}
      ${buttons(primaryButton(joinUrl, `Unirme a ${organizationName}`))}
      ${linkFallback(joinUrl)}
      ${note('Si no esperabas este mensaje, puedes ignorarlo.')}
    `,
  });

/**
 * Código OTP con el que el firmante se autentica al firmar. Lleva el aviso legal porque es el paso
 * que liga el correo del firmante —como medio atribuible— con su firma y su intención de firmar.
 */
export const verificationCodeTemplate = (
  documentName: string,
  code: string,
): string =>
  emailLayout({
    title: 'Código de verificación',
    body: `
      ${paragraph(`Tu código de verificación para firmar <strong>${documentName}</strong> es:`)}
      ${codeBox(code)}
      ${paragraph('Este código vence en 15 minutos.')}
      ${note('Si no esperabas este mensaje, por favor contáctanos.')}
      ${legalNotice(`
        Recibes este correo porque en Firmalo se te indicó como firmante del documento mencionado
        en este mensaje. Por ello, tu dirección de correo electrónico se utiliza como mecanismo de
        autenticación y como medio atribuible para identificarte. Al ingresar este código de
        verificación en Firmalo, confirmas tu identidad y manifiestas tu voluntad de firmar
        electrónicamente dicho documento. Te recomendamos no compartir este correo, sus enlaces ni
        el código de verificación con ninguna otra persona. Si no reconoces al remitente, el
        contenido del documento o el proceso de firma, te sugerimos no firmar el documento.
      `)}
    `,
  });

export const passwordResetOtpTemplate = (code: string): string =>
  emailLayout({
    title: 'Recupera tu contraseña',
    body: `
      ${paragraph('Recibimos una solicitud para restablecer tu contraseña. Usa el siguiente código para continuar:')}
      ${codeBox(code)}
      ${paragraph('Este código vence en 15 minutos.')}
      ${note('Si no solicitaste este cambio, ignora este correo — tu contraseña seguirá siendo la misma.')}
    `,
  });

export const registrationOtpTemplate = (code: string): string =>
  emailLayout({
    title: 'Verifica tu correo',
    body: `
      ${paragraph('Gracias por registrarte. Usa el siguiente código para verificar tu correo y activar tu cuenta:')}
      ${codeBox(code)}
      ${paragraph('Este código vence en 15 minutos.')}
      ${note('Si no esperabas este mensaje, por favor contáctanos.')}
    `,
  });

export const documentInvitationTemplate = (
  signerName: string,
  documentName: string,
  accessUrl: string,
): string =>
  emailLayout({
    title: 'Te invitaron a firmar un documento',
    body: `
      ${paragraph(`Hola <strong>${signerName}</strong>:`)}
      ${paragraph(`Te invitaron a firmar el documento <strong>${documentName}</strong> con Firma Digital Simple. Para continuar, inicia sesión o crea tu cuenta en Firmalo con este mismo correo.`)}
      ${buttons(primaryButton(accessUrl, 'Acceder para firmar'))}
      ${linkFallback(accessUrl)}
      ${note('Si no esperabas este mensaje, puedes ignorarlo.')}
    `,
  });

/** Sin lenguaje de firma a propósito: un testigo sólo puede consultar el documento. */
export const documentWitnessAddedTemplate = (
  witnessName: string,
  documentName: string,
  creatorName: string,
  accessUrl: string,
): string =>
  emailLayout({
    title: 'Te agregaron como testigo de un documento',
    body: `
      ${paragraph(`Hola <strong>${witnessName}</strong>:`)}
      ${paragraph(`<strong>${creatorName}</strong> te agregó como testigo del documento <strong>${documentName}</strong>. Podrás dar seguimiento a su estado desde Firmalo.`)}
      ${buttons(primaryButton(accessUrl, 'Ver documento'))}
      ${linkFallback(accessUrl)}
      ${note('Si no esperabas este mensaje, puedes ignorarlo.')}
    `,
  });

/**
 * Aviso al aprobador asignado de que un documento espera su decisión.
 *
 * Sin lenguaje de firma a propósito: el aprobador no firma, autoriza que el documento salga a
 * firma. El botón entra por `/access-document`, que lleva al detalle del documento, donde están
 * las acciones de aprobar y rechazar.
 *
 * @param reviewerName - Nombre del aprobador, tal como se le saluda.
 * @param documentName - Nombre del documento que espera aprobación.
 * @param creatorName - Nombre de quien creó el documento y pidió la aprobación.
 * @param accessUrl - Enlace de acceso al documento (ver `buildDocumentAccessUrl`).
 * @returns El HTML completo del correo.
 *
 * @example
 * ```ts
 * const html = documentApprovalRequestedTemplate(
 *   'Ana López',
 *   'contrato.pdf',
 *   'Sara Ramírez',
 *   'https://app.firmalo.mx/access-document?docId=doc-1&collabId=col-1&email=ana%40acme.mx',
 * );
 * ```
 */
export const documentApprovalRequestedTemplate = (
  reviewerName: string,
  documentName: string,
  creatorName: string,
  accessUrl: string,
): string =>
  emailLayout({
    title: 'Tienes un documento pendiente de aprobación',
    body: `
      ${paragraph(`Hola <strong>${reviewerName}</strong>:`)}
      ${paragraph(`<strong>${creatorName}</strong> te asignó como aprobador del documento <strong>${documentName}</strong>. El documento no se enviará a firma hasta que lo apruebes; también puedes rechazarlo indicando el motivo.`)}
      ${buttons(primaryButton(accessUrl, 'Revisar documento'))}
      ${linkFallback(accessUrl)}
      ${note('Si no esperabas este mensaje, puedes ignorarlo.')}
    `,
  });

export const documentCancellationPendingTemplate = (
  documentName: string,
  signerName: string,
): string =>
  emailLayout({
    title: 'Solicitud de cancelación de documento',
    tone: 'danger',
    body: `
      ${paragraph(`Hola <strong>${signerName}</strong>:`)}
      ${paragraph('Se ha solicitado la cancelación del siguiente documento que contiene tu firma:')}
      ${calloutBox(`<strong>${documentName}</strong>`, 'danger')}
      ${note('Si no esperabas este mensaje, por favor contáctanos de inmediato.')}
    `,
  });

/**
 * Aviso a propietarios y administradores de que alguien se incorporó a su organización.
 *
 * Es informativo y no una acción a resolver: quien lo recibe no tiene que aprobar nada —la
 * persona ya está dentro—, sólo enterarse y, si algo no cuadra, ir a la pantalla de miembros.
 * Por eso el botón lleva a la lista y no al perfil del nuevo miembro.
 */
export const organizationMemberJoinedTemplate = (
  recipientName: string,
  memberFullName: string,
  memberEmail: string,
  organizationName: string,
  roleName: string,
  membersUrl: string,
): string => {
  const row = (label: string, value: string): string => `
        <tr>
          <td style="width: 35%; padding: 10px 12px; border-bottom: 1px solid ${colors.border}; background-color: ${colors.background}; color: ${colors.muted}; font-size: 13px;">${label}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid ${colors.border}; color: ${colors.text}; font-size: 13px;">${value}</td>
        </tr>`;

  return emailLayout({
    title: `Nuevo miembro en ${organizationName}`,
    body: `
      ${paragraph(`Hola ${recipientName}, <strong>${memberFullName}</strong> se unió a <strong>${organizationName}</strong> en Firmalo.`)}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; border-top: 1px solid ${colors.border}; margin: 24px 0;">
        ${row('Nombre', memberFullName)}
        ${row('Correo', memberEmail)}
        ${row('Rol asignado', roleName)}
      </table>
      ${buttons(primaryButton(membersUrl, 'Ver miembros de la organización'))}
      ${linkFallback(membersUrl)}
      ${note(`Recibes este aviso porque administras ${organizationName}.`)}
    `,
  });
};

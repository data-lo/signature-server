import {
  documentInvitationTemplate,
  documentPendingTemplate,
} from './email.templates';

const DOCUMENT_URL =
  'https://app.example.com/access-document?docId=doc-1&collabId=collab-1&email=ana%40correo.com';

function render(): string {
  return documentPendingTemplate(
    'Ana López',
    'creador@correo.com',
    'contrato.pdf',
    DOCUMENT_URL,
  );
}

/** Los botones del correo: enlaces con estilo de botón (`display: inline-block`). */
function buttons(html: string): { href: string; label: string }[] {
  return [
    ...html.matchAll(
      /<a href="([^"]+)" style="display: inline-block;[^"]*">\s*([^<]+?)\s*<\/a>/g,
    ),
  ].map(([, href, label]) => ({ href, label }));
}

/**
 * Historia "Actualizar acciones en correo de invitación a firma": el correo de solicitud de firma
 * lleva una sola acción, "Firmar documento", hacia el flujo de firma de ese documento.
 */
describe('documentPendingTemplate', () => {
  it('ofrece un único botón, "Firmar documento", hacia el flujo de firma del documento', () => {
    expect(buttons(render())).toEqual([
      { href: DOCUMENT_URL, label: 'Firmar documento' },
    ]);
  });

  it('ya no muestra "Ver todo a firmar" ni el rótulo anterior "Ver este documento"', () => {
    const html = render();

    expect(html).not.toContain('Ver todo a firmar');
    expect(html).not.toContain('Ver este documento');
    expect(html).not.toContain('/dashboard/documents');
  });

  /** El enlace de texto es la salida para clientes que no pintan botones: mismo destino. */
  it('conserva el enlace de texto con la misma URL del botón', () => {
    expect(render()).toContain(
      `<a href="${DOCUMENT_URL}" style="color: #2E7D32;">${DOCUMENT_URL}</a>`,
    );
  });

  it('conserva el saludo, el solicitante y el documento', () => {
    const html = render();

    expect(html).toContain('Hola <strong>Ana López</strong>');
    expect(html).toContain('href="mailto:creador@correo.com"');
    expect(html).toContain('<strong>contrato.pdf</strong>');
  });

  /**
   * Quitar el segundo botón no toca el armazón que hace al correo legible en móvil y en los
   * clientes que ignoran CSS externo: viewport, contenedor de 600px y la tabla de presentación.
   */
  it('mantiene la estructura que sostiene el diseño y la responsividad', () => {
    const html = render();

    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    );
    expect(html).toContain('max-width: 600px; margin: 0 auto;');
    expect(html).toContain(
      '<table role="presentation" style="margin: 32px 0;">',
    );
    expect(html.match(/<td[\s>]/g)).toHaveLength(1);
  });

  /** El cambio es sólo de este correo: la invitación a quien aún no tiene cuenta no se toca. */
  it('no cambia el correo de invitación a firmar sin cuenta', () => {
    const html = documentInvitationTemplate(
      'Ana López',
      'contrato.pdf',
      DOCUMENT_URL,
    );

    expect(buttons(html)).toEqual([
      { href: DOCUMENT_URL, label: 'Acceder para firmar' },
    ]);
  });
});

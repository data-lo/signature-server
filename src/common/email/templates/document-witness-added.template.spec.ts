import { documentWitnessAddedTemplate } from './email.templates';

const DOCUMENT_URL = 'https://app.example.com/public/documents/doc-1';

function render(): string {
  return documentWitnessAddedTemplate(
    'Ana López',
    'contrato.pdf',
    'Sara Ramírez',
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
 * Historia "Redirigir a testigos a la vista pública del documento desde el correo de invitación":
 * el correo dice que es una invitación como testigo y lleva a la vista pública, sin sesión.
 */
describe('documentWitnessAddedTemplate', () => {
  it('ofrece un único botón, "Consultar documento", hacia la vista pública', () => {
    expect(buttons(render())).toEqual([
      { href: DOCUMENT_URL, label: 'Consultar documento' },
    ]);
  });

  it('dice que es testigo y que no necesita cuenta ni iniciar sesión', () => {
    const html = render();

    expect(html).toContain('te agregó como <strong>testigo</strong>');
    expect(html).toContain('sin crear una cuenta ni iniciar sesión');
    expect(html).not.toMatch(/firmar el documento|Firmar documento/);
  });
});

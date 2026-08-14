import {
  buildAllDocumentsUrl,
  buildDocumentAccessUrl,
  buildPublicDocumentUrl,
} from './document-access-url.util';

describe('document-access-url.util', () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;

  afterEach(() => {
    process.env.FRONTEND_URL = originalFrontendUrl;
  });

  describe('buildDocumentAccessUrl', () => {
    it('apunta a /access-document con el contexto del colaborador', () => {
      process.env.FRONTEND_URL = 'https://app.example.com';

      expect(
        buildDocumentAccessUrl('doc-1', 'collab-1', 'firmante@correo.com'),
      ).toBe(
        'https://app.example.com/access-document?docId=doc-1&collabId=collab-1&email=firmante%40correo.com',
      );
    });

    // Regresión: el enlace NUNCA debe apuntar directo al documento — sin sesión, el middleware
    // del frontend lo desvía a /login y se pierde qué documento se iba a firmar.
    it('no enlaza directo a /documents/:id ni a /dashboard/documents/:id', () => {
      const url = buildDocumentAccessUrl('doc-1', 'collab-1', 'a@b.com');

      expect(url).not.toMatch(/\/documents\/doc-1/);
      expect(url).toContain('/access-document?');
    });

    it('escapa el email en el query string', () => {
      process.env.FRONTEND_URL = 'https://app.example.com';

      expect(
        buildDocumentAccessUrl('doc-1', 'collab-1', 'nombre+alias@correo.com'),
      ).toContain('email=nombre%2Balias%40correo.com');
    });
  });

  // La normalización de `FRONTEND_URL` (diagonal final, espacios, fallback) se prueba en
  // `shared/utils/frontend-url.util.spec.ts`, que es donde vive ahora. Acá solo se verifica que
  // estos enlaces la apliquen — un `//` en medio dejaría el correo con una URL rota.
  describe('normalización de la base', () => {
    it('quita las diagonales finales para no generar URLs con //', () => {
      process.env.FRONTEND_URL = 'https://app.example.com/';

      expect(buildAllDocumentsUrl()).toBe(
        'https://app.example.com/dashboard/documents',
      );
      expect(buildPublicDocumentUrl('doc-1')).toBe(
        'https://app.example.com/public/documents/doc-1',
      );
      expect(buildDocumentAccessUrl('doc-1', 'collab-1', 'a@b.com')).toContain(
        'https://app.example.com/access-document?',
      );
    });
  });

  describe('buildAllDocumentsUrl', () => {
    it('apunta ya bajo /dashboard, evitando el redirect 308 heredado', () => {
      process.env.FRONTEND_URL = 'https://app.example.com';

      expect(buildAllDocumentsUrl()).toBe(
        'https://app.example.com/dashboard/documents',
      );
    });
  });
});

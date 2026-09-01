import {
  ADVANCED_SIGNATURE_QUERY_PARAM,
  buildAdvancedSignatureUrl,
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

  /**
   * Historia "Redirigir QR de firma avanzada a la vista pública y resaltar al firmante". Es la URL
   * que se codifica en el QR estampado junto a cada firma avanzada.
   */
  describe('buildAdvancedSignatureUrl', () => {
    it('apunta a la vista pública del documento, señalando la firma por query', () => {
      process.env.FRONTEND_URL = 'https://app.example.com';

      expect(buildAdvancedSignatureUrl('doc-1', 'collab-1')).toBe(
        'https://app.example.com/public/documents/doc-1?firma=collab-1',
      );
    });

    /**
     * Antes apuntaba a `/public/documents/:id/signatures/:collaboratorId`, una pantalla que
     * mostraba esa firma sola, fuera del documento al que pertenece. Esa ruta sigue existiendo
     * para los QR ya estampados —viven dentro de PDFs que no se regeneran—, pero los nuevos ya no
     * se generan así.
     */
    it('ya no apunta a la pantalla de una firma suelta', () => {
      process.env.FRONTEND_URL = 'https://app.example.com';

      expect(buildAdvancedSignatureUrl('doc-1', 'collab-1')).not.toContain(
        '/signatures/',
      );
    });

    /** Criterio "el enlace funciona en los ambientes configurados usando su URL base". */
    it('usa la base del ambiente configurado', () => {
      process.env.FRONTEND_URL = 'https://staging.firma-lo.com/';

      expect(buildAdvancedSignatureUrl('doc-1', 'collab-1')).toBe(
        'https://staging.firma-lo.com/public/documents/doc-1?firma=collab-1',
      );
    });

    /** Dos firmantes del mismo documento no pueden compartir el enlace: es lo que los distingue. */
    it('da una URL distinta por firmante del mismo documento', () => {
      process.env.FRONTEND_URL = 'https://app.example.com';

      expect(buildAdvancedSignatureUrl('doc-1', 'collab-1')).not.toBe(
        buildAdvancedSignatureUrl('doc-1', 'collab-2'),
      );
    });

    /**
     * El nombre del parámetro se exporta porque lo consume el frontend; si aquí se renombrara sin
     * actualizar allá, el QR abriría la vista pública sin resaltar a nadie y nada fallaría.
     */
    it('el parámetro publicado es el que viaja en la URL', () => {
      process.env.FRONTEND_URL = 'https://app.example.com';

      expect(buildAdvancedSignatureUrl('doc-1', 'collab-1')).toContain(
        `${ADVANCED_SIGNATURE_QUERY_PARAM}=collab-1`,
      );
    });
  });
});

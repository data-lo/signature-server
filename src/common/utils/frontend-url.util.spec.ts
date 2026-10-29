import { frontendBaseUrl, publicWebAppBaseUrl } from './frontend-url.util';

describe('frontend-url.util', () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;

  afterEach(() => {
    process.env.FRONTEND_URL = originalFrontendUrl;
  });

  it('devuelve la base configurada tal cual cuando ya viene normalizada', () => {
    process.env.FRONTEND_URL = 'https://app.ejemplo.com';

    expect(frontendBaseUrl()).toBe('https://app.ejemplo.com');
  });

  /**
   * El caso que motivó centralizar esto: escribir la variable con `/` al final es lo natural en un
   * panel de despliegue, y cada consumidor que la leía crudo generaba `//` — enlaces de correo con
   * `...//join`, `success_url` de Stripe con `...//dashboard`, y un origin de CORS que no casaba
   * con el header `Origin` del navegador (que nunca lleva diagonal final).
   */
  it('quita la diagonal final para no generar URLs con //', () => {
    process.env.FRONTEND_URL = 'https://app.ejemplo.com/';

    expect(frontendBaseUrl()).toBe('https://app.ejemplo.com');
  });

  it('quita también varias diagonales finales seguidas', () => {
    process.env.FRONTEND_URL = 'https://app.ejemplo.com///';

    expect(frontendBaseUrl()).toBe('https://app.ejemplo.com');
  });

  it('ignora los espacios alrededor del valor configurado', () => {
    process.env.FRONTEND_URL = '  https://app.ejemplo.com/  ';

    expect(frontendBaseUrl()).toBe('https://app.ejemplo.com');
  });

  it('cae a localhost — nunca a un host interno de Docker — si no hay FRONTEND_URL', () => {
    delete process.env.FRONTEND_URL;

    expect(frontendBaseUrl()).toBe('http://localhost:3001');
  });

  it('trata una FRONTEND_URL vacía como no configurada', () => {
    process.env.FRONTEND_URL = '   ';

    expect(frontendBaseUrl()).toBe('http://localhost:3001');
  });

  describe('publicWebAppBaseUrl', () => {
    const originalPublicUrl = process.env.PUBLIC_WEB_APP_URL;

    afterEach(() => {
      process.env.PUBLIC_WEB_APP_URL = originalPublicUrl;
    });

    it('usa PUBLIC_WEB_APP_URL sin diagonales finales', () => {
      process.env.PUBLIC_WEB_APP_URL = 'https://app.firmalo.com//';
      process.env.FRONTEND_URL = 'https://otra.ejemplo.com';

      expect(publicWebAppBaseUrl()).toBe('https://app.firmalo.com');
    });

    it('sin PUBLIC_WEB_APP_URL cae en FRONTEND_URL, que es lo que se usaba antes', () => {
      delete process.env.PUBLIC_WEB_APP_URL;
      process.env.FRONTEND_URL = 'https://app.ejemplo.com/';

      expect(publicWebAppBaseUrl()).toBe('https://app.ejemplo.com');
    });
  });
});

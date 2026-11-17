import { BadRequestException } from '@nestjs/common';

import {
  PasswordPolicyService,
  WEAK_PASSWORD_MESSAGE,
} from './password-policy.service';

/**
 * Historia "Centralizar política de contraseñas en PasswordPolicyService": la política se basa en
 * longitud y en resistencia a contraseñas comunes o previsibles, no en reglas de composición.
 */
describe('PasswordPolicyService', () => {
  const policy = new PasswordPolicyService();

  const rejectionOf = (password: string): unknown => {
    try {
      policy.assertValid(password);
      return undefined;
    } catch (error) {
      return error;
    }
  };

  describe('rechaza contraseñas comunes, débiles o previsibles', () => {
    it.each([
      // Los ejemplos del ticket.
      'password',
      'Password123!',
      '12345678',
      'qwerty123',
      'admin123',
      // Cortas aunque no sean comunes.
      'k9#Lm2!x',
      'h7#Kp2!vQx9',
      // Lista local, sin importar mayúsculas.
      'PASSWORD1234',
      'Qwerty123456',
      'iloveyou1234',
      '123456789012',
      // Palabra base + números, años o símbolos.
      'P@ssw0rd2025!',
      'Admin2024!!!',
      'welcome2024!!',
      'Contraseña123!',
      'Contrasena2026',
      'SuperSecret123',
      'Firmalo2024!#',
      // Teclado, secuencias, repeticiones.
      'qwertyuiopasdf',
      '1qaz2wsx3edc',
      'abcdefghijkl',
      'zyxwvutsrqpo',
      'aaaaaaaaaaaa',
      '111111111111!',
      'abcabcabcabc',
      'xk9qxk9qxk9q',
    ])('%p', (password) => {
      expect(rejectionOf(password)).toBeInstanceOf(BadRequestException);
    });
  });

  describe('acepta contraseñas robustas de 12 o más caracteres', () => {
    it.each([
      'mi gato duerme en la azotea',
      'correct horse battery staple',
      'h7#Kp2!vQx9z',
      'xk9QmW2pLr7t',
      '1928374650192',
      'ñandú-come-pan-dulce',
      'Tr0mb0n-azul-del-lunes',
      // Una palabra común de paso no invalida una frase propia.
      'mi password favorito es otro',
      // Todo en minúsculas y sin símbolos: no hay reglas de composición.
      'lavadoraenlaazotea',
    ])('%p', (password) => {
      expect(() => policy.assertValid(password)).not.toThrow();
    });

    it('cuenta caracteres y no unidades UTF-16: 12 emojis bastan, 11 no', () => {
      const emojis = [
        '🐢',
        '🌵',
        '🎻',
        '🧭',
        '🪁',
        '🦉',
        '🍋',
        '🛶',
        '🧩',
        '🪐',
        '🦔',
        '🎲',
      ];

      expect(() => policy.assertValid(emojis.join(''))).not.toThrow();
      expect(rejectionOf(emojis.slice(0, 11).join(''))).toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('seguridad de la respuesta', () => {
    /**
     * El mismo mensaje para la longitud, la lista y los patrones: decir cuál falló orientaría a
     * quien prueba contraseñas.
     */
    it.each(['corta', 'password1234', 'Admin2024!!!', 'aaaaaaaaaaaa'])(
      'no revela la regla que falló (%p)',
      (password) => {
        const error = rejectionOf(password) as BadRequestException;

        expect(error.getStatus()).toBe(400);
        expect(error.message).toBe(WEAK_PASSWORD_MESSAGE);
      },
    );

    it('la respuesta no incluye la contraseña ni su versión normalizada', () => {
      const error = rejectionOf('Password123!') as BadRequestException;
      const serialized = JSON.stringify(error.getResponse());

      expect(serialized).not.toContain('Password123!');
      expect(serialized).not.toContain('password123!');
    });

    it('no escribe en la consola al validar', () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
        (method) => jest.spyOn(console, method).mockImplementation(() => {}),
      );

      rejectionOf('Password123!');
      policy.assertValid('mi gato duerme en la azotea');

      spies.forEach((spy) => {
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      });
    });

    it('no transforma la contraseña recibida', () => {
      const password = '  Mi Gato Duerme En La Azotea  ';
      const original = password.slice();

      policy.assertValid(password);

      expect(password).toBe(original);
    });

    it('rechaza un valor que no es texto sin lanzar otro tipo de error', () => {
      expect(rejectionOf(undefined as unknown as string)).toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});

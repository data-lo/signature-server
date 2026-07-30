import { maskEmail } from './mask-email.util';

describe('maskEmail', () => {
  it('enmascara el local-part dejando el primer y último carácter (ejemplo de la historia)', () => {
    expect(maskEmail('usuario@dominio.com')).toBe('u***o@dominio.com');
  });

  it('conserva el dominio intacto', () => {
    expect(maskEmail('ana@empresa.com')).toBe('a***a@empresa.com');
  });

  it('local-part de un solo carácter no revienta y sigue enmascarando', () => {
    expect(maskEmail('a@dominio.com')).toBe('a***@dominio.com');
  });

  it('local-part de dos caracteres', () => {
    expect(maskEmail('ab@dominio.com')).toBe('a***b@dominio.com');
  });
});

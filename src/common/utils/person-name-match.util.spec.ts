import { nameTokens, personNameMatches } from './person-name-match.util';

describe('personNameMatches', () => {
  it('normaliza acentos, mayúsculas y signos', () => {
    expect(nameTokens('  José  Pérez-Núñez ')).toEqual([
      'JOSE',
      'PEREZ',
      'NUNEZ',
    ]);
  });

  it.each([
    ['Ana López', 'ANA LOPEZ PEREZ'],
    ['ana lopez', 'LOPEZ PEREZ ANA'],
    ['María José Núñez', 'MARIA JOSE NUNEZ GARCIA'],
  ])('%s corresponde a %s', (expected, actual) => {
    expect(personNameMatches(expected, actual)).toBe(true);
  });

  it.each([
    ['Ana López', 'LUIS MARTINEZ'],
    ['Ana López Pérez', 'ANA LOPEZ'],
    ['Ana López', null],
    ['', 'ANA LOPEZ'],
  ])('%s no corresponde a %s', (expected, actual) => {
    expect(personNameMatches(expected, actual)).toBe(false);
  });
});

import {
  certificateSubjectMatches,
  certificateTaxIdMatches,
} from './certificate-subject.util';

const CERTIFICATE = { rfc: 'LOPA800101AB1', name: 'ANA LOPEZ PEREZ' };

describe('certificateTaxIdMatches', () => {
  it.each(['LOPA800101AB1', 'lopa800101ab1', ' LOPA 800101 AB1 '])(
    'no da un falso negativo por mayúsculas o espacios: %s',
    (registered) => {
      expect(certificateTaxIdMatches('LOPA800101AB1', registered)).toBe(true);
    },
  );

  it('distingue dos RFC diferentes', () => {
    expect(certificateTaxIdMatches('LOPA800101AB1', 'MAML900101XY2')).toBe(
      false,
    );
  });
});

describe('certificateSubjectMatches', () => {
  it('con RFC: exige el mismo, sin distinguir mayúsculas ni espacios', () => {
    expect(
      certificateSubjectMatches(CERTIFICATE, {
        taxId: ' lopa800101ab1 ',
        fullName: 'Otro Nombre',
      }),
    ).toBe(true);
  });

  it('con RFC distinto: no corresponde aunque el nombre sí', () => {
    expect(
      certificateSubjectMatches(CERTIFICATE, {
        taxId: 'MAML900101XY2',
        fullName: 'Ana López',
      }),
    ).toBe(false);
  });

  it('sin RFC: compara el nombre del colaborador con el CN', () => {
    expect(
      certificateSubjectMatches(CERTIFICATE, {
        taxId: null,
        fullName: 'Ana López',
      }),
    ).toBe(true);
    expect(
      certificateSubjectMatches(CERTIFICATE, {
        taxId: null,
        fullName: 'Luis Martínez',
      }),
    ).toBe(false);
  });
});

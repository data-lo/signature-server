import { certificateSubjectMatches } from './certificate-subject.util';

const CERTIFICATE = { rfc: 'LOPA800101AB1', name: 'ANA LOPEZ PEREZ' };

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

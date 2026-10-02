import {
  findMissingApproval,
  toBiometricDecisionEvidence,
} from './biometric-decision-evidence.mapper';

describe('toBiometricDecisionEvidence', () => {
  it('conserva estado, puntaje y método y descarta URLs y datos de la identificación', () => {
    const evidence = toBiometricDecisionEvidence('Approved', {
      liveness_checks: [
        {
          status: 'Approved',
          score: 98.5,
          method: 'ACTIVE_3D',
          reference_image: 'https://media/selfie.jpg',
          video_url: 'https://media/video.mp4',
        },
      ],
      face_matches: [
        { status: 'Approved', score: 91, source_image: 'https://media/a.jpg' },
      ],
      id_verifications: [
        {
          status: 'Approved',
          first_name: 'ANA',
          personal_number: 'CURP123',
          portrait_image: 'https://media/portrait.jpg',
        },
      ],
    });

    expect(evidence).toEqual({
      sessionStatus: 'Approved',
      livenessChecks: [
        { status: 'Approved', score: 98.5, method: 'ACTIVE_3D' },
      ],
      faceMatches: [{ status: 'Approved', score: 91, method: null }],
      idVerifications: [{ status: 'Approved', score: null, method: null }],
    });
    expect(JSON.stringify(evidence)).not.toMatch(/https|CURP|ANA/);
  });

  it('acepta la forma V2 (objetos) y deja vacío lo que no vino', () => {
    expect(
      toBiometricDecisionEvidence('Declined', {
        liveness: { status: 'Declined', score: 12 },
      }),
    ).toEqual({
      sessionStatus: 'Declined',
      livenessChecks: [{ status: 'Declined', score: 12, method: null }],
      faceMatches: [],
      idVerifications: [],
    });
    expect(toBiometricDecisionEvidence(null, null).livenessChecks).toEqual([]);
  });
});

describe('findMissingApproval', () => {
  const approved = { status: 'Approved', score: 99, method: null };

  it('firmante con cuenta: exige prueba de vida y face match aprobados', () => {
    expect(
      findMissingApproval(
        {
          sessionStatus: 'Approved',
          livenessChecks: [approved],
          faceMatches: [approved],
          idVerifications: [],
        },
        false,
      ),
    ).toBeNull();
  });

  it('sin face match no aprueba, aunque la sesión diga Approved', () => {
    expect(
      findMissingApproval(
        {
          sessionStatus: 'Approved',
          livenessChecks: [approved],
          faceMatches: [],
          idVerifications: [],
        },
        false,
      ),
    ).toBe('face match');
  });

  it('una sola prueba no aprobada basta para no aprobar', () => {
    expect(
      findMissingApproval(
        {
          sessionStatus: 'Approved',
          livenessChecks: [approved, { ...approved, status: 'In Review' }],
          faceMatches: [approved],
          idVerifications: [],
        },
        false,
      ),
    ).toBe('prueba de vida');
  });

  it('invitado: exige además la verificación de identificación', () => {
    expect(
      findMissingApproval(
        {
          sessionStatus: 'Approved',
          livenessChecks: [approved],
          faceMatches: [approved],
          idVerifications: [],
        },
        true,
      ),
    ).toBe('verificación de identificación');
  });
});

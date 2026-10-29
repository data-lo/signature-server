import { IDENTITY_CHECK_OUTCOME_ENUM } from '../enums/identity-check-outcome.enum';
import { summarizeDiditDecision } from './didit-decision.mapper';

describe('summarizeDiditDecision', () => {
  it('resume un veredicto aprobado completo', () => {
    expect(
      summarizeDiditDecision({
        id_verification: { status: 'Approved' },
        face_match: { status: 'match', score: 97.4 },
        liveness: { status: 'live', score: 91 },
      }),
    ).toEqual({
      documentReading: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
      faceMatch: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
      liveness: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
    });
  });

  it('distingue cuál de las comprobaciones falló', () => {
    expect(
      summarizeDiditDecision({
        id_verification: { status: 'Approved' },
        face_match: { status: 'no_match' },
        liveness: { status: 'live' },
      }),
    ).toEqual({
      documentReading: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
      faceMatch: IDENTITY_CHECK_OUTCOME_ENUM.FAILED,
      liveness: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
    });
  });

  describe('respuesta V3: cada bloque es un arreglo', () => {
    it('resume un veredicto V3 completo', () => {
      expect(
        summarizeDiditDecision({
          id_verifications: [{ status: 'Approved', document_type: 'ID Card' }],
          liveness_checks: [{ status: 'live', score: 91 }],
          face_matches: [{ status: 'match', score: 97.4 }],
        }),
      ).toEqual({
        documentReading: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
        faceMatch: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
        liveness: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
      });
    });

    it('con varias comprobaciones del mismo tipo, manda la peor', () => {
      expect(
        summarizeDiditDecision({
          id_verifications: [{ status: 'Approved' }, { status: 'Declined' }],
          liveness_checks: [{ status: 'live' }, { status: 'In Review' }],
        }),
      ).toEqual({
        documentReading: IDENTITY_CHECK_OUTCOME_ENUM.FAILED,
        faceMatch: null,
        liveness: IDENTITY_CHECK_OUTCOME_ENUM.IN_REVIEW,
      });
    });

    it('ignora las entradas ilegibles en lugar de dar por perdido el bloque', () => {
      expect(
        summarizeDiditDecision({
          face_matches: [{ status: 'something_new' }, { status: 'match' }],
        })?.faceMatch,
      ).toBe(IDENTITY_CHECK_OUTCOME_ENUM.PASSED);
    });

    it('un arreglo vacío es "no reportado", no una aprobación', () => {
      expect(
        summarizeDiditDecision({
          id_verifications: [],
          face_matches: [{ status: 'match' }],
        })?.documentReading,
      ).toBeNull();
    });

    it('un veredicto V2 ya guardado se sigue resumiendo igual', () => {
      expect(
        summarizeDiditDecision({
          id_verification: { status: 'Approved' },
          face_match: { status: 'match' },
          liveness: { status: 'live' },
        }),
      ).toEqual({
        documentReading: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
        faceMatch: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
        liveness: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
      });
    });
  });

  describe('vocabulario del proveedor', () => {
    it.each([
      ['Approved', IDENTITY_CHECK_OUTCOME_ENUM.PASSED],
      ['match', IDENTITY_CHECK_OUTCOME_ENUM.PASSED],
      ['LIVE', IDENTITY_CHECK_OUTCOME_ENUM.PASSED],
      ['Declined', IDENTITY_CHECK_OUTCOME_ENUM.FAILED],
      ['No Match', IDENTITY_CHECK_OUTCOME_ENUM.FAILED],
      ['not_live', IDENTITY_CHECK_OUTCOME_ENUM.FAILED],
      ['NOT-LIVE', IDENTITY_CHECK_OUTCOME_ENUM.FAILED],
      ['In Review', IDENTITY_CHECK_OUTCOME_ENUM.IN_REVIEW],
      ['warning', IDENTITY_CHECK_OUTCOME_ENUM.IN_REVIEW],
    ])('normaliza "%s" a %s', (providerValue, expected) => {
      expect(
        summarizeDiditDecision({ face_match: { status: providerValue } })
          ?.faceMatch,
      ).toBe(expected);
    });

    it('acepta el bloque como cadena suelta, no sólo como objeto', () => {
      expect(summarizeDiditDecision({ liveness: 'live' })?.liveness).toBe(
        IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
      );
    });

    it('acepta los alias con los que Didit ha publicado cada bloque', () => {
      expect(
        summarizeDiditDecision({
          document_verification: { status: 'Approved' },
          face_verification: { status: 'match' },
          liveness_detection: { status: 'live' },
        }),
      ).toEqual({
        documentReading: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
        faceMatch: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
        liveness: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
      });
    });

    it('un valor desconocido NO se interpreta como aprobado', () => {
      expect(
        summarizeDiditDecision({
          face_match: { status: 'something_new' },
          liveness: { status: 'live' },
        }),
      ).toEqual({
        documentReading: null,
        faceMatch: null,
        liveness: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
      });
    });
  });

  describe('no expone datos personales', () => {
    /** Un veredicto con la forma real de Didit V3: casi todo son datos del titular. */
    const decisionConPii = {
      id_verifications: [
        {
          status: 'Approved',
          first_name: 'Juan',
          last_name: 'Pérez López',
          date_of_birth: '1985-01-01',
          document_number: 'PELJ850101HDFRNN08',
          address: 'Calle Falsa 123',
          portrait_image: 'https://cdn.didit.me/portrait.jpg',
          front_image: 'https://cdn.didit.me/ine-front.jpg',
        },
      ],
      face_matches: [{ status: 'match', score: 97.4 }],
      liveness_checks: [{ status: 'live', score: 91 }],
      aml: { status: 'clear', hits: [] },
    };

    it('devuelve exactamente tres campos y ninguno más', () => {
      expect(Object.keys(summarizeDiditDecision(decisionConPii)!)).toEqual([
        'documentReading',
        'faceMatch',
        'liveness',
      ]);
    });

    it('no deja rastro del titular ni de las puntuaciones en el resumen', () => {
      const serializado = JSON.stringify(
        summarizeDiditDecision(decisionConPii),
      );

      for (const dato of [
        'Juan',
        'Pérez',
        '1985-01-01',
        'PELJ850101HDFRNN08',
        'Calle Falsa',
        'cdn.didit.me',
        '97.4',
        '91',
        'aml',
      ]) {
        expect(serializado).not.toContain(dato);
      }
    });
  });

  describe('veredictos que no se pueden resumir', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['un arreglo', [] as unknown as Record<string, unknown>],
      ['un objeto vacío', {}],
      ['sólo campos que no son comprobaciones', { session_id: 'ses_1' }],
    ])('devuelve null con %s', (_caso, decision) => {
      expect(summarizeDiditDecision(decision)).toBeNull();
    });
  });
});

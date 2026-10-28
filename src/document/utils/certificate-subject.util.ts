import { personNameMatches } from 'src/common/utils/person-name-match.util';

/** A quién se espera como titular del certificado. */
export interface ExpectedCertificateSubject {
  /** RFC del colaborador, si se conoce (la integración lo manda por firmante FIEL). */
  taxId: string | null;
  /** Nombre y apellidos del colaborador. */
  fullName: string;
}

/**
 * Indica si el titular de un certificado corresponde al colaborador esperado. El correo no
 * participa: los certificados del SAT no lo traen.
 *
 * - **Con RFC**: tiene que ser el mismo, sin espacios ni distinguir mayúsculas.
 * - **Sin RFC**: el nombre del colaborador tiene que estar contenido en el CN del certificado
 *   (`personNameMatches`: sin acentos y en cualquier orden).
 *
 * @param certificate - RFC y nombre (CN) del certificado.
 * @param expected - Titular esperado.
 * @returns `true` si corresponde.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * certificateSubjectMatches({ rfc: 'LOPA800101AB1', name: 'ANA LOPEZ PEREZ' }, { taxId: null, fullName: 'Ana López' }); // true
 * ```
 */
export function certificateSubjectMatches(
  certificate: { rfc: string; name: string },
  expected: ExpectedCertificateSubject,
): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, '').toUpperCase();
  if (expected.taxId) {
    return normalize(certificate.rfc) === normalize(expected.taxId);
  }
  return personNameMatches(expected.fullName, certificate.name);
}

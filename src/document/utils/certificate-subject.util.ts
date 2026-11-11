import { personNameMatches } from 'src/common/utils/person-name-match.util';
import { normalizeTaxId } from './tax-id.util';

/** A quién se espera como titular del certificado. */
export interface ExpectedCertificateSubject {
  /** RFC del colaborador, si se conoce (la integración lo manda por firmante FIEL). */
  taxId: string | null;
  /** Nombre y apellidos del colaborador. */
  fullName: string;
}

/**
 * Compara el RFC de un certificado con el registrado para el firmante, sin distinguir mayúsculas
 * ni espacios.
 *
 * @param certificateTaxId - RFC extraído del certificado.
 * @param registeredTaxId - RFC registrado para el firmante.
 * @returns `true` si son el mismo RFC.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * certificateTaxIdMatches('LOPA800101AB1', ' lopa800101ab1 '); // true
 * ```
 */
export function certificateTaxIdMatches(
  certificateTaxId: string,
  registeredTaxId: string,
): boolean {
  return normalizeTaxId(certificateTaxId) === normalizeTaxId(registeredTaxId);
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
  if (expected.taxId) {
    return certificateTaxIdMatches(certificate.rfc, expected.taxId);
  }
  return personNameMatches(expected.fullName, certificate.name);
}

import { SealEntity } from '../seal/entities/seal.entity';
import { toConservationRecord } from './conservation-record.util';

/**
 * Mismo CMS SignedData que `tsa-certificate.util.spec.ts`: un certificado autofirmado real con
 * `CN=Test TSA, O=Test PSC, C=MX` y serie 4A1B2C3D. Sirve para probar el respaldo que extrae del
 * ASN.1 cuando la evidencia se guardó sin esos campos.
 */
const CMS_BASE64 =
  'MIIDjwYJKoZIhvcNAQcCoIIDgDCCA3wCAQExDTALBglghkgBZQMEAgEwJAYJKoZIhvcNAQcBoBcEFWhvbGEtbXVuZG8tZXZpZGVuY2lhCqCCAa8wggGrMIIBUaADAgECAgRKGyw9MAoGCCqGSM49BAMCMDMxETAPBgNVBAMMCFRlc3QgVFNBMREwDwYDVQQKDAhUZXN0IFBTQzELMAkGA1UEBhMCTVgwHhcNMjYwODI3MTgwNjM3WhcNMjcwODI3MTgwNjM3WjAzMREwDwYDVQQDDAhUZXN0IFRTQTERMA8GA1UECgwIVGVzdCBQU0MxCzAJBgNVBAYTAk1YMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJHOJY30iMvggdywg6JP+hC8l7ogdCgDnrunBZkklArQbBkJAz6E9DtNVlMuzC9jypxWh5lbpX8Py4QiEHp+IV6NTMFEwHQYDVR0OBBYEFBUIxTafnILGpbiZEVcea2LGzAnsMB8GA1UdIwQYMBaAFBUIxTafnILGpbiZEVcea2LGzAnsMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhANXcs8sKgBLuhrTNX8TYAYjkft9QwTSnEcp4ywPtr2xMAiAh8FUsFK68JhxcGDcKl509H9cOftJ6Pnnf4FaawZyuEzGCAY0wggGJAgEBMDswMzERMA8GA1UEAwwIVGVzdCBUU0ExETAPBgNVBAoMCFRlc3QgUFNDMQswCQYDVQQGEwJNWAIEShssPTALBglghkgBZQMEAgGggeQwGAYJKoZIhvcNAQkDMQsGCSqGSIb3DQEHATAcBgkqhkiG9w0BCQUxDxcNMjYwODI3MTgwNjM3WjAvBgkqhkiG9w0BCQQxIgQgQ7XgrBofCLIuYAXovuRl4knoZu433yrmBFlRA5Xy9poweQYJKoZIhvcNAQkPMWwwajALBglghkgBZQMEASowCwYJYIZIAWUDBAEWMAsGCWCGSAFlAwQBAjAKBggqhkiG9w0DBzAOBggqhkiG9w0DAgICAIAwDQYIKoZIhvcNAwICAUAwBwYFKw4DAgcwDQYIKoZIhvcNAwICASgwCgYIKoZIzj0EAwIERzBFAiEAn04MlsE6WsTM1el7evE7uYXzZnke0/edGFRkWrK2ZEgCIE8207j6a9Uw+2oBN95tk9zOesY6LCyc6F4PwF/bvwmY';

function sealWith(
  integrityEvidence: Partial<SealEntity['integrityEvidence']> = {},
): SealEntity {
  return {
    id: 'seal-1',
    documentId: 'doc-1',
    sealedAt: new Date('2026-07-30T15:59:22Z'),
    integrityEvidence,
  } as SealEntity;
}

describe('toConservationRecord', () => {
  it('toma la fecha de emisión del sello persistido', () => {
    expect(toConservationRecord(sealWith())).toEqual(
      expect.objectContaining({
        issuedAt: new Date('2026-07-30T15:59:22Z'),
      }),
    );
  });

  /**
   * El caso normal desde que `SealMapper` extrae el certificado al sellar: los tres renglones de
   * la tabla NOM-151 salen llenos sin volver a tocar el ASN.1.
   */
  it('lee el certificado y la serie que quedaron guardados al sellar', () => {
    const record = toConservationRecord(
      sealWith({
        certificateSubjectCommonName: 'PSC Codex',
        certificateSerialNumber: '4A1B2C3D',
        fileBase64: CMS_BASE64,
      }),
    );

    expect(record?.tsaCertificate).toBe('PSC Codex');
    expect(record?.serialNumber).toBe('4A1B2C3D');
  });

  /**
   * Evidencia sellada ANTES de que existiera la extracción, o cuyo archivo no se pudo parsear
   * entonces. La hoja se anexa al PDF una sola vez y ya no se puede corregir, así que se intenta
   * extraer en el momento en vez de imprimir el renglón vacío para siempre.
   */
  it('extrae del ASN.1 cuando la evidencia se guardó sin esos campos', () => {
    const record = toConservationRecord(sealWith({ fileBase64: CMS_BASE64 }));

    expect(record?.tsaCertificate).toBe('Test TSA');
    expect(record?.serialNumber).toBe('4A1B2C3D');
  });

  /** Un archivo que el parser no reconoce deja los renglones vacíos, sin tumbar la hoja. */
  it('deja en null lo que no se puede extraer, sin lanzar', () => {
    const record = toConservationRecord(
      sealWith({ fileBase64: 'no-es-un-cms' }),
    );

    expect(record?.tsaCertificate).toBeNull();
    expect(record?.serialNumber).toBeNull();
    expect(record?.issuedAt).toEqual(new Date('2026-07-30T15:59:22Z'));
  });

  /** Evidencia sin archivo: mismo criterio, la hoja se arma igual. */
  it('tolera una evidencia sin archivo del que extraer', () => {
    const record = toConservationRecord(sealWith({}));

    expect(record?.tsaCertificate).toBeNull();
    expect(record?.serialNumber).toBeNull();
  });

  // Firma simple (nunca se sella) o sellado fallido: es best-effort y no debe romper la hoja.
  it('devuelve null cuando el documento no tiene sello', () => {
    expect(toConservationRecord(null)).toBeNull();
    expect(toConservationRecord(undefined)).toBeNull();
  });

  // Sellos anteriores a la columna `sealed_at`: el dato no se puede recuperar, pero la hoja se
  // arma igual.
  it('tolera un sello viejo sin fecha de emisión registrada', () => {
    const seal = sealWith();
    seal.sealedAt = null;

    expect(toConservationRecord(seal)).toEqual(
      expect.objectContaining({ issuedAt: null }),
    );
  });
});

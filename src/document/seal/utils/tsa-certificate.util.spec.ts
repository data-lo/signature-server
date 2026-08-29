import { extractTsaCertificateInfo } from './tsa-certificate.util';

/**
 * CMS SignedData (DER, Base64) generado con `openssl cms -sign` sobre un certificado
 * autofirmado real: `openssl req -x509 ... -set_serial 0x4A1B2C3D` + `openssl cms -sign`. Es el
 * mismo envoltorio (ContentInfo → SignedData → certificates[0]) que un sello RFC 3161, así que
 * sirve para probar la extracción sin depender de una evidencia real de Seal Service.
 *
 * Serie y `notBefore` de ese certificado, verificados con `openssl x509 -noout -serial -dates`:
 * serial=4A1B2C3D, notBefore=Aug 27 18:06:37 2026 GMT.
 */
const CMS_BASE64 =
  'MIIDjwYJKoZIhvcNAQcCoIIDgDCCA3wCAQExDTALBglghkgBZQMEAgEwJAYJKoZIhvcNAQcBoBcEFWhvbGEtbXVuZG8tZXZpZGVuY2lhCqCCAa8wggGrMIIBUaADAgECAgRKGyw9MAoGCCqGSM49BAMCMDMxETAPBgNVBAMMCFRlc3QgVFNBMREwDwYDVQQKDAhUZXN0IFBTQzELMAkGA1UEBhMCTVgwHhcNMjYwODI3MTgwNjM3WhcNMjcwODI3MTgwNjM3WjAzMREwDwYDVQQDDAhUZXN0IFRTQTERMA8GA1UECgwIVGVzdCBQU0MxCzAJBgNVBAYTAk1YMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJHOJY30iMvggdywg6JP+hC8l7ogdCgDnrunBZkklArQbBkJAz6E9DtNVlMuzC9jypxWh5lbpX8Py4QiEHp+IV6NTMFEwHQYDVR0OBBYEFBUIxTafnILGpbiZEVcea2LGzAnsMB8GA1UdIwQYMBaAFBUIxTafnILGpbiZEVcea2LGzAnsMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhANXcs8sKgBLuhrTNX8TYAYjkft9QwTSnEcp4ywPtr2xMAiAh8FUsFK68JhxcGDcKl509H9cOftJ6Pnnf4FaawZyuEzGCAY0wggGJAgEBMDswMzERMA8GA1UEAwwIVGVzdCBUU0ExETAPBgNVBAoMCFRlc3QgUFNDMQswCQYDVQQGEwJNWAIEShssPTALBglghkgBZQMEAgGggeQwGAYJKoZIhvcNAQkDMQsGCSqGSIb3DQEHATAcBgkqhkiG9w0BCQUxDxcNMjYwODI3MTgwNjM3WjAvBgkqhkiG9w0BCQQxIgQgQ7XgrBofCLIuYAXovuRl4knoZu433yrmBFlRA5Xy9poweQYJKoZIhvcNAQkPMWwwajALBglghkgBZQMEASowCwYJYIZIAWUDBAEWMAsGCWCGSAFlAwQBAjAKBggqhkiG9w0DBzAOBggqhkiG9w0DAgICAIAwDQYIKoZIhvcNAwICAUAwBwYFKw4DAgcwDQYIKoZIhvcNAwICASgwCgYIKoZIzj0EAwIERzBFAiEAn04MlsE6WsTM1el7evE7uYXzZnke0/edGFRkWrK2ZEgCIE8207j6a9Uw+2oBN95tk9zOesY6LCyc6F4PwF/bvwmY';

/**
 * El MISMO CMS de arriba, envuelto en un `TimeStampResp` de RFC 3161
 * (`SEQUENCE { PKIStatusInfo, TimeStampToken }`), que es como PSC CODEX entrega la evidencia
 * NOM-151 en producción.
 *
 * Es la regresión del bug: la extracción sólo reconocía el `ContentInfo` desnudo, así que contra
 * la evidencia real devolvía `null` y la tabla NOM-151 salía vacía aunque el certificado
 * estuviera ahí dentro. Se construye envolviendo el fixture en vez de copiar una evidencia real:
 * lo que importa es la estructura, y así no entra al repositorio la constancia de un cliente.
 */
const TIMESTAMP_RESP_BASE64 =
  'MIIDmDADAgEAMIIDjwYJKoZIhvcNAQcCoIIDgDCCA3wCAQExDTALBglghkgBZQMEAgEwJAYJKoZIhvcNAQcBoBcEFWhvbGEtbXVuZG8tZXZpZGVuY2lhCqCCAa8wggGrMIIBUaADAgECAgRKGyw9MAoGCCqGSM49BAMCMDMxETAPBgNVBAMMCFRlc3QgVFNBMREwDwYDVQQKDAhUZXN0IFBTQzELMAkGA1UEBhMCTVgwHhcNMjYwODI3MTgwNjM3WhcNMjcwODI3MTgwNjM3WjAzMREwDwYDVQQDDAhUZXN0IFRTQTERMA8GA1UECgwIVGVzdCBQU0MxCzAJBgNVBAYTAk1YMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJHOJY30iMvggdywg6JP+hC8l7ogdCgDnrunBZkklArQbBkJAz6E9DtNVlMuzC9jypxWh5lbpX8Py4QiEHp+IV6NTMFEwHQYDVR0OBBYEFBUIxTafnILGpbiZEVcea2LGzAnsMB8GA1UdIwQYMBaAFBUIxTafnILGpbiZEVcea2LGzAnsMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhANXcs8sKgBLuhrTNX8TYAYjkft9QwTSnEcp4ywPtr2xMAiAh8FUsFK68JhxcGDcKl509H9cOftJ6Pnnf4FaawZyuEzGCAY0wggGJAgEBMDswMzERMA8GA1UEAwwIVGVzdCBUU0ExETAPBgNVBAoMCFRlc3QgUFNDMQswCQYDVQQGEwJNWAIEShssPTALBglghkgBZQMEAgGggeQwGAYJKoZIhvcNAQkDMQsGCSqGSIb3DQEHATAcBgkqhkiG9w0BCQUxDxcNMjYwODI3MTgwNjM3WjAvBgkqhkiG9w0BCQQxIgQgQ7XgrBofCLIuYAXovuRl4knoZu433yrmBFlRA5Xy9poweQYJKoZIhvcNAQkPMWwwajALBglghkgBZQMEASowCwYJYIZIAWUDBAEWMAsGCWCGSAFlAwQBAjAKBggqhkiG9w0DBzAOBggqhkiG9w0DAgICAIAwDQYIKoZIhvcNAwICAUAwBwYFKw4DAgcwDQYIKoZIhvcNAwICASgwCgYIKoZIzj0EAwIERzBFAiEAn04MlsE6WsTM1el7evE7uYXzZnke0/edGFRkWrK2ZEgCIE8207j6a9Uw+2oBN95tk9zOesY6LCyc6F4PwF/bvwmY';

describe('extractTsaCertificateInfo', () => {
  it('extrae la serie y el notBefore del certificado embebido en un CMS SignedData', () => {
    const result = extractTsaCertificateInfo(CMS_BASE64);

    expect(result).toMatchObject({
      serialNumber: '4A1B2C3D',
      issuedAt: new Date('2026-08-27T18:06:37.000Z'),
    });
  });

  /**
   * El CN es lo que la tabla NOM-151 de las hojas de evidencia imprime como "Certificado (TSA)".
   * El DN del fixture es `CN=Test TSA, O=Test PSC, C=MX`: se busca por OID justamente para no
   * devolver la organización o el país según cómo el PSC ordene los componentes.
   */
  it('extrae el CN del emisor, no el primer componente del DN', () => {
    expect(extractTsaCertificateInfo(CMS_BASE64)?.subjectCommonName).toBe(
      'Test TSA',
    );
  });

  /** La envoltura que usa PSC CODEX: sin reconocerla, `ContentInfo` lanza y se devolvía null. */
  it('extrae el certificado aunque el CMS venga envuelto en un TimeStampResp', () => {
    expect(extractTsaCertificateInfo(TIMESTAMP_RESP_BASE64)).toMatchObject({
      serialNumber: '4A1B2C3D',
      subjectCommonName: 'Test TSA',
    });
  });

  it('devuelve null si el Base64 ni siquiera decodifica a ASN.1 válido', () => {
    expect(
      extractTsaCertificateInfo(Buffer.from('no es ASN.1').toString('base64')),
    ).toBeNull();
  });

  it('devuelve null con una cadena vacía', () => {
    expect(extractTsaCertificateInfo('')).toBeNull();
  });

  it('devuelve null con Base64 inválido en vez de lanzar', () => {
    expect(extractTsaCertificateInfo('***no-es-base64***')).toBeNull();
  });

  it('devuelve null si el ContentInfo no es un SignedData', () => {
    // OCTET STRING vacío: ASN.1 válido, pero no es el ContentInfo de un CMS.
    expect(
      extractTsaCertificateInfo(Buffer.from([0x04, 0x00]).toString('base64')),
    ).toBeNull();
  });
});

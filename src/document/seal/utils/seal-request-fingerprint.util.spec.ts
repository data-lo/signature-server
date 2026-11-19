import type { SimpleSignatureDTO } from '../dto/simple-signature.dto';
import {
  buildSealIdempotencyKey,
  canonicalJson,
  fingerprintSimpleSealRequest,
} from './seal-request-fingerprint.util';

function signer(curp: string, signedAt = '2026-11-19T18:00:00.000Z') {
  return {
    curp,
    email: `${curp.toLowerCase()}@correo.example`,
    name: 'Nombre',
    lastName: 'Apellido',
    signedAt,
    verificationData: {
      code: '123456',
      verificationMethod: 'EMAIL_OTP',
      usedAt: '2026-11-19T17:59:00.000Z',
    },
    signatureMedia: {
      signatureImage: 'cnVicmljYQ==',
      identityDocumentFrontImage: 'ZnJlbnRl',
      identityDocumentBackImage: 'cmV2ZXJzbw==',
    },
  };
}

const DTO: SimpleSignatureDTO = {
  documentId: 'doc-1',
  originalHash: 'hash-original',
  signedHash: 'hash-firmado',
  signatures: [signer('BBBB'), signer('AAAA')],
} as unknown as SimpleSignatureDTO;

describe('seal-request-fingerprint', () => {
  it('la clave es estable por documento', () => {
    expect(buildSealIdempotencyKey('doc-1')).toBe(
      'signature-server:document:doc-1:v1',
    );
    expect(fingerprintSimpleSealRequest(DTO).idempotencyKey).toBe(
      'signature-server:document:doc-1:v1',
    );
  });

  it('el mismo contenido en otro orden produce el mismo payload y el mismo hash', () => {
    const reordered = {
      ...DTO,
      signatures: [...DTO.signatures].reverse(),
    };

    const a = fingerprintSimpleSealRequest(DTO);
    const b = fingerprintSimpleSealRequest(reordered);

    expect(b.payload).toEqual(a.payload);
    expect(b.requestHash).toBe(a.requestHash);
    expect(a.payload.signatures.map(({ curp }) => curp)).toEqual([
      'AAAA',
      'BBBB',
    ]);
    expect(a.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('un cambio en el contenido cambia el hash', () => {
    const changed = {
      ...DTO,
      signatures: [signer('BBBB', '2026-11-19T18:00:01.000Z'), signer('AAAA')],
    } as unknown as SimpleSignatureDTO;

    expect(fingerprintSimpleSealRequest(changed).requestHash).not.toBe(
      fingerprintSimpleSealRequest(DTO).requestHash,
    );
  });

  it('serializa con las llaves ordenadas, omite undefined y normaliza fechas', () => {
    expect(
      canonicalJson({
        b: 1,
        a: [2, { d: 3, c: undefined, e: new Date('2026-11-19T18:00:00Z') }],
      }),
    ).toBe('{"a":[2,{"d":3,"e":"2026-11-19T18:00:00.000Z"}],"b":1}');
  });
});

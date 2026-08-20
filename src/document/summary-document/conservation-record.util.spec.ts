import { SealEntity } from '../seal/entities/seal.entity';
import { toConservationRecord } from './conservation-record.util';

describe('toConservationRecord', () => {
  const seal = {
    id: 'seal-1',
    documentId: 'doc-1',
    sealedAt: new Date('2026-07-30T15:59:22Z'),
  } as SealEntity;

  it('toma la fecha de emisión del sello persistido', () => {
    expect(toConservationRecord(seal)).toEqual(
      expect.objectContaining({ issuedAt: seal.sealedAt }),
    );
  });

  /**
   * El DN del certificado (TSA) y el número de serie del sello viven únicamente dentro del token
   * RFC 3161 del PSC, y nadie los expone por separado. Se devuelven en null a propósito: la hoja
   * imprime el renglón vacío en vez de inventar un valor en un documento legal.
   */
  it('deja en null los datos que el proveedor no expone por separado', () => {
    const record = toConservationRecord(seal);

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
    const record = toConservationRecord({ ...seal, sealedAt: null });

    expect(record).toEqual(expect.objectContaining({ issuedAt: null }));
  });
});

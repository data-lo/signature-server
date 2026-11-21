import { COLABORATOR_TYPE_ENUM } from '../../enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { SEALING_TYPE_ENUM } from '../enums/sealing-type.enum';
import { resolveSealingType } from './resolve-sealing-type.util';

const signer = (signatureType: SIGNATURE_TYPE_ENUM | null) => ({
  colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
  signatureType,
});

const witness = {
  colaboratorType: COLABORATOR_TYPE_ENUM.WITNESS,
  signatureType: null,
};

describe('resolveSealingType', () => {
  it.each([
    [
      'todos FIEL',
      [signer(SIGNATURE_TYPE_ENUM.FIEL), signer(SIGNATURE_TYPE_ENUM.FIEL)],
      SEALING_TYPE_ENUM.ADVANCED,
    ],
    [
      'todos SIMPLE',
      [signer(SIGNATURE_TYPE_ENUM.SIMPLE)],
      SEALING_TYPE_ENUM.SIMPLE,
    ],
    [
      'firmantes sin tipo (filas anteriores a la firma avanzada)',
      [signer(null)],
      SEALING_TYPE_ENUM.SIMPLE,
    ],
    [
      'SIMPLE con un testigo, que no cuenta',
      [signer(SIGNATURE_TYPE_ENUM.SIMPLE), witness],
      SEALING_TYPE_ENUM.SIMPLE,
    ],
  ])('%s → %s', (_case, collaborators, expected) => {
    expect(resolveSealingType(collaborators)).toBe(expected);
  });

  it.each([
    [
      'biométrica: no tiene contrato de sellado',
      [signer(SIGNATURE_TYPE_ENUM.BIOMETRIC)],
    ],
    [
      'mezcla FIEL y SIMPLE',
      [signer(SIGNATURE_TYPE_ENUM.FIEL), signer(SIGNATURE_TYPE_ENUM.SIMPLE)],
    ],
    [
      'mezcla SIMPLE y BIOMETRIC',
      [
        signer(SIGNATURE_TYPE_ENUM.SIMPLE),
        signer(SIGNATURE_TYPE_ENUM.BIOMETRIC),
      ],
    ],
    ['sin firmantes', [witness]],
    ['sin colaboradores', []],
  ])('%s → null', (_case, collaborators) => {
    expect(resolveSealingType(collaborators)).toBeNull();
  });
});

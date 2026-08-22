import { CollaboratorEntity } from '../entities/collaborator.entity';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { isAdvancedSignatureDocument } from './advanced-signature-document.util';

function signer(signatureType: SIGNATURE_TYPE_ENUM | null) {
  return { signatureType } as CollaboratorEntity;
}

describe('isAdvancedSignatureDocument', () => {
  it('es avanzado cuando todos los firmantes usan e.firma', () => {
    expect(
      isAdvancedSignatureDocument([
        signer(SIGNATURE_TYPE_ENUM.FIEL),
        signer(SIGNATURE_TYPE_ENUM.FIEL),
      ]),
    ).toBe(true);
  });

  it('no es avanzado cuando los firmantes usan firma simple', () => {
    expect(
      isAdvancedSignatureDocument([signer(SIGNATURE_TYPE_ENUM.SIMPLE)]),
    ).toBe(false);
  });

  // El tipo de firma se decide una vez por documento, así que esto no debería ocurrir; si ocurre,
  // la hoja simple es la que sí imprime a todos los firmantes.
  it('cae a la hoja simple si un documento mezclara tipos de firma', () => {
    expect(
      isAdvancedSignatureDocument([
        signer(SIGNATURE_TYPE_ENUM.FIEL),
        signer(SIGNATURE_TYPE_ENUM.SIMPLE),
      ]),
    ).toBe(false);
  });

  // Documentos creados antes de que el tipo de firma se persistiera por colaborador.
  it('cae a la hoja simple si el tipo de firma no está registrado', () => {
    expect(isAdvancedSignatureDocument([signer(null)])).toBe(false);
  });

  it('no es avanzado sin firmantes', () => {
    expect(isAdvancedSignatureDocument([])).toBe(false);
  });
});

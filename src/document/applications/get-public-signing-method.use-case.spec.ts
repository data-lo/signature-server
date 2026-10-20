import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { GetPublicSigningMethodUseCase } from './get-public-signing-method.use-case';

describe('GetPublicSigningMethodUseCase', () => {
  let collaborator: Record<string, unknown> | null;
  let findOne: jest.Mock;
  let useCase: GetPublicSigningMethodUseCase;

  beforeEach(() => {
    collaborator = {
      id: 'c-1',
      documentId: 'd-1',
      colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      accountId: null,
      email: 'Ana@Correo.mx',
      signatureType: SIGNATURE_TYPE_ENUM.BIOMETRIC,
    };
    findOne = jest.fn(async () => collaborator);
    useCase = new GetPublicSigningMethodUseCase({ findOne } as never);
  });

  it('busca al firmante de ESE documento', async () => {
    await useCase.execute('d-1', 'c-1', 'ana@correo.mx');

    expect(findOne).toHaveBeenCalledWith({
      where: {
        id: 'c-1',
        documentId: 'd-1',
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      },
    });
  });

  it.each([SIGNATURE_TYPE_ENUM.BIOMETRIC, SIGNATURE_TYPE_ENUM.FIEL])(
    'devuelve %s para un invitado sin cuenta con ese correo (sin distinguir mayúsculas)',
    async (signatureType) => {
      collaborator!.signatureType = signatureType;

      await expect(
        useCase.execute('d-1', 'c-1', ' ANA@correo.mx '),
      ).resolves.toEqual({ signatureType });
    },
  );

  it.each<[string, () => void]>([
    ['no existe en el documento', () => (collaborator = null)],
    ['el correo es otro', () => (collaborator!.email = 'otra@correo.mx')],
    ['ya tiene cuenta vinculada', () => (collaborator!.accountId = 'acc-1')],
    [
      'su firma es simple',
      () => (collaborator!.signatureType = SIGNATURE_TYPE_ENUM.SIMPLE),
    ],
    ['no tiene tipo de firma', () => (collaborator!.signatureType = null)],
  ])('devuelve null si %s', async (_case, mutate) => {
    mutate();

    await expect(
      useCase.execute('d-1', 'c-1', 'ana@correo.mx'),
    ).resolves.toEqual({ signatureType: null });
  });
});

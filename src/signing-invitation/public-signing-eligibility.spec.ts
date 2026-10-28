import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';

import { isPublicSigningAllowed } from './public-signing-eligibility';

function signer(
  signatureType: SIGNATURE_TYPE_ENUM | null,
  lifecycleStatus?: USER_LIFECYCLE_STATUS_ENUM,
  colaboratorType = COLABORATOR_TYPE_ENUM.SIGNER,
) {
  return {
    colaboratorType,
    signatureType,
    accountId: lifecycleStatus ? 'acc-1' : null,
    account: lifecycleStatus ? { user: { lifecycleStatus } } : null,
  } as never;
}

describe('isPublicSigningAllowed', () => {
  it.each([
    [
      'SIMPLE con usuario provisional',
      signer(
        SIGNATURE_TYPE_ENUM.SIMPLE,
        USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
      ),
      true,
    ],
    ['SIMPLE sin cuenta', signer(SIGNATURE_TYPE_ENUM.SIMPLE), false],
    [
      'SIMPLE con cuenta ACTIVE',
      signer(SIGNATURE_TYPE_ENUM.SIMPLE, USER_LIFECYCLE_STATUS_ENUM.ACTIVE),
      false,
    ],
    ['FIEL sin cuenta', signer(SIGNATURE_TYPE_ENUM.FIEL), true],
    [
      'FIEL con cuenta',
      signer(SIGNATURE_TYPE_ENUM.FIEL, USER_LIFECYCLE_STATUS_ENUM.ACTIVE),
      false,
    ],
    ['BIOMETRIC sin cuenta', signer(SIGNATURE_TYPE_ENUM.BIOMETRIC), true],
    [
      'BIOMETRIC con usuario provisional',
      signer(
        SIGNATURE_TYPE_ENUM.BIOMETRIC,
        USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
      ),
      false,
    ],
    ['firmante sin tipo de firma', signer(null), false],
    [
      'testigo',
      signer(
        SIGNATURE_TYPE_ENUM.FIEL,
        undefined,
        COLABORATOR_TYPE_ENUM.WITNESS,
      ),
      false,
    ],
  ])('%s → %s', (_case, collaborator, expected) => {
    expect(isPublicSigningAllowed(collaborator)).toBe(expected);
  });
});

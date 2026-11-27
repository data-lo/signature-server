import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

import { PublicVerificationUploadFilter } from './public-verification-upload.filter';
import { VERIFICATION_MESSAGES } from './public-verification.types';

function hostCapturing() {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  };
  return { host: host as never, response };
}

describe('PublicVerificationUploadFilter', () => {
  const filter = new PublicVerificationUploadFilter();

  it.each([
    [
      'archivo demasiado grande',
      new PayloadTooLargeException('File too large'),
      'INVALID_FILE',
    ],
    [
      'multipart cortado',
      new BadRequestException('Multipart: Unexpected end of form'),
      'INVALID_FILE',
    ],
    [
      'archivo en otro campo',
      new BadRequestException('Unexpected field'),
      'UNSUPPORTED_FILE',
    ],
    [
      'más de un archivo',
      new BadRequestException('Too many files'),
      'UNSUPPORTED_FILE',
    ],
    [
      'partes de más',
      new BadRequestException('Too many parts'),
      'UNSUPPORTED_FILE',
    ],
  ] as const)(
    '%s → 200 %s, sin el mensaje de multer',
    (_, exception, status) => {
      const { host, response } = hostCapturing();

      filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(200);
      expect(response.json).toHaveBeenCalledWith({
        success: true,
        message: VERIFICATION_MESSAGES[status],
        data: { status, message: VERIFICATION_MESSAGES[status] },
      });
    },
  );
});

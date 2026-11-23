import { createHash } from 'crypto';
import { PassThrough } from 'stream';

import { VERIFICATION_ARTIFACT_TYPE_ENUM } from './public-verification.types';
import { VerificationUploadStorage } from './verification-upload.storage';

function upload(
  originalname: string,
  mimetype: string,
  chunks: Buffer[],
  error?: Error,
) {
  const stream = new PassThrough();
  const storage = new VerificationUploadStorage();
  const result = new Promise<{ error?: unknown; info?: any }>((resolve) =>
    storage._handleFile(
      {} as never,
      { originalname, mimetype, stream } as never,
      (err, info) => resolve({ error: err, info }),
    ),
  );
  for (const chunk of chunks) stream.write(chunk);
  if (error) stream.destroy(error);
  else stream.end();
  return result;
}

describe('VerificationUploadStorage', () => {
  it('deja en el archivo sólo el análisis: ni buffer, ni ruta, ni tamaño', async () => {
    const chunks = [Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 1)];

    const { error, info } = await upload(
      'final.pdf',
      'application/pdf',
      chunks,
    );

    expect(error).toBeFalsy();
    expect(Object.keys(info)).toEqual(['verification']);
    expect(info.verification).toEqual({
      ok: true,
      artifactType: VERIFICATION_ARTIFACT_TYPE_ENUM.FINAL_DOCUMENT,
      digest: createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),
      documentId: null,
    });
  });

  it('drena el stream de un archivo no admitido sin procesarlo', async () => {
    const { info } = await upload('foto.png', 'image/png', [
      Buffer.alloc(4096),
    ]);

    expect(info.verification).toEqual(
      expect.objectContaining({ ok: false, problem: 'UNSUPPORTED' }),
    );
  });

  it('propaga un error del stream (subida cortada)', async () => {
    const { error } = await upload(
      'final.pdf',
      'application/pdf',
      [Buffer.from('%PDF')],
      new Error('aborted'),
    );

    expect(error).toEqual(new Error('aborted'));
  });

  it('_removeFile no tiene nada que borrar', () => {
    const callback = jest.fn();

    new VerificationUploadStorage()._removeFile(
      {} as never,
      {} as never,
      callback,
    );

    expect(callback).toHaveBeenCalledWith(null);
  });
});

import { validateIndexerWebhookPayload } from './indexer-webhook-payload.schema';

const VALID = {
  jobId: '9f2c4e1a7b3d5f60819a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70',
  documentId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  state: 'received',
  duplicate: true,
  clientDocumentId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
};

describe('validateIndexerWebhookPayload', () => {
  it.each(['received', 'indexed', 'failed'])('acepta el estado %s', (state) => {
    expect(
      validateIndexerWebhookPayload({ ...VALID, state }).reason,
    ).toBeNull();
  });

  it('acepta un cuerpo sin duplicate y lo devuelve completo', () => {
    const { duplicate: _duplicate, ...body } = VALID;

    expect(validateIndexerWebhookPayload(body)).toEqual({
      payload: body,
      reason: null,
    });
  });

  it.each([
    ['un valor que no es objeto', null],
    ['un arreglo', []],
    ['sin jobId', { ...VALID, jobId: undefined }],
    ['con jobId vacío', { ...VALID, jobId: '' }],
    ['sin documentId', { ...VALID, documentId: undefined }],
    ['sin clientDocumentId', { ...VALID, clientDocumentId: undefined }],
    [
      'con clientDocumentId que no es UUID',
      { ...VALID, clientDocumentId: 'x' },
    ],
    ['con un estado desconocido', { ...VALID, state: 'processing' }],
    ['con el estado en mayúsculas', { ...VALID, state: 'RECEIVED' }],
    ['con un estado heredado de Object', { ...VALID, state: 'constructor' }],
    ['con duplicate que no es booleano', { ...VALID, duplicate: 'true' }],
  ])('rechaza %s', (_, body) => {
    const result = validateIndexerWebhookPayload(body);

    expect(result.payload).toBeNull();
    expect(result.reason).toEqual(expect.any(String));
  });

  it('no incluye valores del cuerpo en el motivo', () => {
    const { reason } = validateIndexerWebhookPayload({
      ...VALID,
      clientDocumentId: 'dato-del-cuerpo',
    });

    expect(reason).not.toContain('dato-del-cuerpo');
  });
});

import { validateDiditWebhookPayload } from './didit-webhook-payload.schema';

/** Los campos base que Didit manda en toda entrega, con valores de una sesión real. */
const BASE = {
  application_id: 'app_1',
  event_id: 'evt_1',
  session_id: 'ses_1',
  status: 'In Progress',
  timestamp: 1700000000,
  webhook_type: 'status.updated',
  workflow_id: 'wf_1',
  vendor_data: 'user-1',
};

const APPROVED = {
  ...BASE,
  status: 'Approved',
  decision: { id_verifications: [{ status: 'Approved' }] },
};

describe('validateDiditWebhookPayload', () => {
  it('acepta el evento inicial sin decision', () => {
    const result = validateDiditWebhookPayload(BASE);

    expect(result).toEqual({
      payload: BASE,
      status: 'In Progress',
      reason: null,
    });
  });

  it('acepta el evento final aprobado con su decision', () => {
    expect(validateDiditWebhookPayload(APPROVED)).toMatchObject({
      status: 'Approved',
      reason: null,
    });
  });

  /**
   * `Not Started` y `Kyc Expired` llegaban de verdad desde Didit y se rechazaban con un 400 pese a
   * que el dominio ya sabía traducirlos: el proveedor daba la entrega por fallida y la reintentaba
   * en bucle. Esta lista tiene que cubrir lo mismo que `DIDIT_STATUS_MAP`.
   */
  it.each([
    'Not Started',
    'In Review',
    'Declined',
    'Abandoned',
    'Expired',
    'Kyc Expired',
  ])('acepta el estado %s', (status) => {
    expect(validateDiditWebhookPayload({ ...BASE, status })).toMatchObject({
      status,
      reason: null,
    });
  });

  it('devuelve el cuerpo intacto: lo que se audita y lo que procesa el dominio es lo mismo', () => {
    const conExtras = { ...BASE, campo_que_no_conocemos: 'valor' };
    const result = validateDiditWebhookPayload(conExtras);

    expect(result.payload).toBe(conExtras);
  });

  it('normaliza la variante in_progress sin reescribir el payload', () => {
    const result = validateDiditWebhookPayload({
      ...BASE,
      status: 'in_progress',
    });

    expect(result).toMatchObject({ status: 'In Progress', reason: null });
    expect(result.payload.status).toBe('in_progress');
  });

  describe('campos base obligatorios', () => {
    it.each([
      'application_id',
      'event_id',
      'session_id',
      'webhook_type',
      'workflow_id',
      'vendor_data',
    ])('rechaza el cuerpo sin %s', (field) => {
      const result = validateDiditWebhookPayload({
        ...BASE,
        [field]: undefined,
      });

      expect(result.payload).toBeNull();
      expect(result.reason).toContain(field);
    });

    it('rechaza un campo base vacío', () => {
      expect(
        validateDiditWebhookPayload({ ...BASE, session_id: '' }).payload,
      ).toBeNull();
    });

    it('acepta el timestamp en cadena, que es la otra forma que manda Didit', () => {
      expect(
        validateDiditWebhookPayload({ ...BASE, timestamp: '1700000000' })
          .reason,
      ).toBeNull();
    });

    it.each([
      ['ausente', undefined],
      ['no numérico', 'ayer'],
      ['nulo', null],
    ])('rechaza un timestamp %s', (_caso, timestamp) => {
      expect(
        validateDiditWebhookPayload({ ...BASE, timestamp }).payload,
      ).toBeNull();
    });
  });

  describe('un Approved sin veredicto no puede otorgar nada', () => {
    it.each([
      ['sin decision', undefined],
      ['con decision nula', null],
      ['con decision como cadena', 'approved'],
      ['con decision como arreglo', []],
    ])('rechaza el evento %s', (_caso, decision) => {
      const result = validateDiditWebhookPayload({
        ...BASE,
        status: 'Approved',
        decision,
      });

      expect(result.payload).toBeNull();
      expect(result.reason).toContain('decision');
    });
  });

  describe('cuerpos que no cumplen el contrato', () => {
    it('rechaza un estado que este servidor no sabe interpretar', () => {
      const result = validateDiditWebhookPayload({
        ...BASE,
        status: 'Something New',
      });

      expect(result.payload).toBeNull();
    });

    it.each([
      ['null', null],
      ['un arreglo', []],
      ['una cadena', 'Approved'],
      ['un número', 7],
    ])('rechaza %s como cuerpo', (_caso, body) => {
      expect(validateDiditWebhookPayload(body).payload).toBeNull();
    });
  });

  it('no filtra datos del titular en el motivo del rechazo', () => {
    const result = validateDiditWebhookPayload({
      ...BASE,
      status: 'Approved',
      decision: undefined,
      first_name: 'Juan',
      document_number: 'PELJ850101HDFRNN08',
    });

    expect(result.reason).not.toContain('Juan');
    expect(result.reason).not.toContain('PELJ850101HDFRNN08');
  });
});

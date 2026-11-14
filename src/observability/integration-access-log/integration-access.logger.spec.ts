import { INTEGRATION_ACCESS_OUTCOME_ENUM } from './integration-access-log.interface';
import { buildIntegrationAccessLogEvent } from './integration-access-log.sanitizer';
import { IntegrationAccessLogger, levelOf } from './integration-access.logger';

const EVENT = buildIntegrationAccessLogEvent({
  requestId: 'req-1',
  method: 'GET',
  route: '/api/v1/integration/documents',
  statusCode: 200,
  durationMs: 12,
  apiKeyId: null,
  organizationId: null,
  documentId: null,
  ip: null,
  errorCode: null,
});

describe('IntegrationAccessLogger', () => {
  it('escribe una sola línea JSON con timestamp, level y el evento', () => {
    const lines: string[] = [];
    new IntegrationAccessLogger((line) => lines.push(line)).log(EVENT);

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    const parsed = JSON.parse(lines[0]);
    expect(Object.keys(parsed).slice(0, 3)).toEqual([
      'timestamp',
      'level',
      'event',
    ]);
    expect(parsed).toEqual({
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      level: 'info',
      ...EVENT,
    });
  });

  it('por defecto escribe en stdout con salto de línea', () => {
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      new IntegrationAccessLogger().log(EVENT);
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0][0])).toMatch(/^\{.*\}\n$/);
    } finally {
      write.mockRestore();
    }
  });

  it('nunca lanza, aunque falle el destino', () => {
    const logger = new IntegrationAccessLogger(() => {
      throw new Error('EPIPE');
    });
    expect(() => logger.log(EVENT)).not.toThrow();
  });

  it.each([
    [INTEGRATION_ACCESS_OUTCOME_ENUM.SUCCESS, 'info'],
    [INTEGRATION_ACCESS_OUTCOME_ENUM.CLIENT_ERROR, 'info'],
    [INTEGRATION_ACCESS_OUTCOME_ENUM.CLIENT_CLOSED, 'warn'],
    [INTEGRATION_ACCESS_OUTCOME_ENUM.SERVER_ERROR, 'error'],
  ])('levelOf(%s) = %s', (outcome, level) => {
    expect(levelOf(outcome)).toBe(level);
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { DiditApiService } from './didit-api.service';
import {
  DiditConfigurationException,
  DiditResponseException,
  DiditTimeoutException,
  DiditUnavailableException,
} from '../exceptions/identity-verification.exceptions';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const DIDIT_CONFIG: Record<string, string> = {
  DIDIT_API_KEY: 'api-key-de-prueba',
  DIDIT_WORKFLOW_ID: 'wf_ine_selfie',
};

const HOSTED_URL = 'https://verify.didit.me/session/abc';
const USER_ID = 'user-1';
const CALLBACK = 'https://app.firmalo.mx/dashboard';

function axiosError(partial: Record<string, unknown>) {
  const error = Object.assign(new Error('falla de red'), partial);
  mockedAxios.isAxiosError.mockReturnValue(true);
  return error;
}

describe('DiditApiService', () => {
  let service: DiditApiService;
  let config: Record<string, string>;

  beforeEach(async () => {
    jest.clearAllMocks();
    config = { ...DIDIT_CONFIG };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiditApiService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => config[key] },
        },
      ],
    }).compile();

    service = module.get(DiditApiService);
  });

  it('crea la sesión con el workflow configurado y el userId como vendor_data', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        session_id: 'ses_1',
        url: HOSTED_URL,
        workflow_id: 'wf_ine_selfie',
      },
    });

    const session = await service.createSession(USER_ID, CALLBACK);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://verification.didit.me/v2/session/',
      {
        workflow_id: 'wf_ine_selfie',
        vendor_data: USER_ID,
        callback: CALLBACK,
      },
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': 'api-key-de-prueba' }),
      }),
    );
    expect(session.sessionId).toBe('ses_1');
    expect(session.url).toBe(HOSTED_URL);
  });

  it('no conserva el session_token en los datos que se van a persistir', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        session_id: 'ses_1',
        url: HOSTED_URL,
        session_token: 'token-secreto',
        token: 'otro-secreto',
        status: 'Not Started',
      },
    });

    const session = await service.createSession(USER_ID, CALLBACK);

    expect(session.raw).not.toHaveProperty('session_token');
    expect(session.raw).not.toHaveProperty('token');
    expect(session.raw).toHaveProperty('status', 'Not Started');
  });

  it('falla si la respuesta no trae session_id o url', async () => {
    mockedAxios.post.mockResolvedValue({ data: { status: 'Not Started' } });

    await expect(
      service.createSession(USER_ID, CALLBACK),
    ).rejects.toBeInstanceOf(DiditResponseException);
  });

  it('falla explícitamente si falta configuración, sin llamar al proveedor', async () => {
    delete config.DIDIT_WORKFLOW_ID;

    await expect(
      service.createSession(USER_ID, CALLBACK),
    ).rejects.toBeInstanceOf(DiditConfigurationException);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('respeta DIDIT_API_URL y le quita la diagonal final', async () => {
    config.DIDIT_API_URL = 'https://staging.didit.me/';
    mockedAxios.post.mockResolvedValue({
      data: { session_id: 'ses_1', url: HOSTED_URL },
    });

    await service.createSession(USER_ID, CALLBACK);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://staging.didit.me/v2/session/',
      expect.anything(),
      expect.anything(),
    );
  });

  describe('traducción de errores del proveedor', () => {
    it('un error HTTP se traduce a 502', async () => {
      mockedAxios.post.mockRejectedValue(
        axiosError({ response: { status: 401, data: { detail: 'bad key' } } }),
      );

      await expect(
        service.createSession(USER_ID, CALLBACK),
      ).rejects.toBeInstanceOf(DiditResponseException);
    });

    it('un timeout se traduce a 504', async () => {
      mockedAxios.post.mockRejectedValue(axiosError({ code: 'ECONNABORTED' }));

      await expect(
        service.createSession(USER_ID, CALLBACK),
      ).rejects.toBeInstanceOf(DiditTimeoutException);
    });

    it('un fallo de conexión se traduce a 503', async () => {
      mockedAxios.post.mockRejectedValue(axiosError({ code: 'ECONNREFUSED' }));

      await expect(
        service.createSession(USER_ID, CALLBACK),
      ).rejects.toBeInstanceOf(DiditUnavailableException);
    });
  });
});

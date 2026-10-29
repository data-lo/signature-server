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

  describe('firma biométrica (API V3)', () => {
    it('crea la sesión en /v3/session/ con el retrato de referencia', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          session_id: 'ses_bio',
          url: HOSTED_URL,
          session_token: 'secreto',
        },
      });

      const session = await service.createBiometricSession({
        workflowId: 'wf-auth',
        vendorData: 'biometric-signature-attempt:a-1',
        callbackUrl: CALLBACK,
        portraitImageBase64: 'BASE64',
      });

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://verification.didit.me/v3/session/',
        {
          workflow_id: 'wf-auth',
          vendor_data: 'biometric-signature-attempt:a-1',
          callback: CALLBACK,
          portrait_image: 'BASE64',
        },
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'api-key-de-prueba',
          }),
        }),
      );
      expect(session.sessionId).toBe('ses_bio');
      expect(session.raw).not.toHaveProperty('session_token');
    });

    it('sin retrato no manda portrait_image (KYC de invitado)', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { session_id: 'ses_kyc', url: HOSTED_URL },
      });

      await service.createBiometricSession({
        workflowId: 'wf-kyc',
        vendorData: 'biometric-signature-attempt:a-2',
        callbackUrl: CALLBACK,
      });

      expect(mockedAxios.post.mock.calls[0][1]).not.toHaveProperty(
        'portrait_image',
      );
    });

    it('no exige DIDIT_WORKFLOW_ID del onboarding', async () => {
      delete config.DIDIT_WORKFLOW_ID;
      mockedAxios.post.mockResolvedValue({
        data: { session_id: 'ses_bio', url: HOSTED_URL },
      });

      await expect(
        service.createBiometricSession({
          workflowId: 'wf-auth',
          vendorData: 'v',
          callbackUrl: CALLBACK,
        }),
      ).resolves.toBeDefined();
    });

    it('lee el veredicto de una sesión en /v3/session/{id}/decision/', async () => {
      mockedAxios.get.mockResolvedValue({ data: { status: 'Approved' } });

      await expect(service.getSessionDecision('ses 1')).resolves.toEqual({
        status: 'Approved',
      });
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://verification.didit.me/v3/session/ses%201/decision/',
        expect.objectContaining({
          headers: { 'x-api-key': 'api-key-de-prueba' },
        }),
      );
    });

    it('un veredicto que no es objeto es una respuesta inválida', async () => {
      mockedAxios.get.mockResolvedValue({ data: 'texto' });
      mockedAxios.isAxiosError.mockReturnValue(false);

      await expect(service.getSessionDecision('ses_1')).rejects.toBeInstanceOf(
        DiditResponseException,
      );
    });

    it('sin API key no llama a Didit', async () => {
      delete config.DIDIT_API_KEY;

      await expect(service.getSessionDecision('ses_1')).rejects.toBeInstanceOf(
        DiditConfigurationException,
      );
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });
  });
});

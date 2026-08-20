import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { TurnstileService } from './turnstile.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const TOKEN = '0.token-generado-por-el-widget';

/** Reproduce la forma que `axios.isAxiosError` reconoce, sin depender de la red. */
function axiosError(partial: { status?: number; code?: string } = {}): unknown {
  return {
    isAxiosError: true,
    code: partial.code,
    response: partial.status ? { status: partial.status } : undefined,
    message: 'fallo simulado',
  };
}

describe('TurnstileService', () => {
  let service: TurnstileService;
  let configValues: Record<string, string>;

  beforeEach(async () => {
    jest.clearAllMocks();
    configValues = { TURNSTILE_SECRET_KEY: 'secreto-de-prueba' };
    mockedAxios.isAxiosError.mockImplementation(
      (error: unknown) =>
        Boolean(error) &&
        (error as { isAxiosError?: boolean }).isAxiosError === true,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TurnstileService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => configValues[key] },
        },
      ],
    }).compile();

    service = module.get(TurnstileService);
  });

  it('acepta el token cuando Siteverify responde success', async () => {
    mockedAxios.post.mockResolvedValue({ data: { success: true } });

    await expect(service.verifyToken(TOKEN)).resolves.toBeUndefined();

    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    );
    expect((body as URLSearchParams).get('secret')).toBe('secreto-de-prueba');
    expect((body as URLSearchParams).get('response')).toBe(TOKEN);
  });

  it('rechaza un token inválido, expirado o ya usado', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { success: false, 'error-codes': ['timeout-or-duplicate'] },
    });

    await expect(service.verifyToken(TOKEN)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rechaza un token vacío sin llamar a Siteverify', async () => {
    await expect(service.verifyToken('   ')).rejects.toThrow(
      BadRequestException,
    );
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  // El caso que motiva el "falla cerrado": sin la variable configurada, la alternativa habría
  // sido dejar pasar el registro y desproteger el endpoint justo en el entorno mal desplegado.
  it('rechaza el registro si TURNSTILE_SECRET_KEY no está configurada', async () => {
    configValues = {};

    await expect(service.verifyToken(TOKEN)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('rechaza el registro si Siteverify no responde', async () => {
    mockedAxios.post.mockRejectedValue(axiosError({ code: 'ECONNABORTED' }));

    await expect(service.verifyToken(TOKEN)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  // Una clave secreta equivocada es un problema del despliegue: reintentar el CAPTCHA nunca lo
  // arregla, así que no se le devuelve al usuario el mensaje de "vuelve a completarlo".
  it('distingue un error de configuración del servidor de un token malo del usuario', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { success: false, 'error-codes': ['invalid-input-secret'] },
    });

    await expect(service.verifyToken(TOKEN)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('no filtra la clave secreta ni el token en el mensaje de error', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { success: false, 'error-codes': ['invalid-input-response'] },
    });

    await expect(service.verifyToken(TOKEN)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('secreto-de-prueba'),
      }),
    );
  });
});

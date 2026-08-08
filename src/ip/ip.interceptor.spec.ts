import { of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { IpInterceptor } from './ip.interceptor';

function buildContext(request: any): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

const nextHandler: CallHandler = { handle: () => of('ok') };

describe('IpInterceptor', () => {
  let interceptor: IpInterceptor;

  beforeEach(() => {
    interceptor = new IpInterceptor();
  });

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });

  function resolveClientIp(request: any): string {
    interceptor.intercept(buildContext(request), nextHandler);
    return request.clientIp;
  }

  it('usa x-forwarded-for (primer valor) cuando está presente', () => {
    const request = {
      headers: { 'x-forwarded-for': '203.0.113.1, 70.41.3.18' },
    };
    expect(resolveClientIp(request)).toBe('203.0.113.1');
  });

  it('usa x-client-ip si no hay x-forwarded-for', () => {
    const request = { headers: { 'x-client-ip': '203.0.113.5' } };
    expect(resolveClientIp(request)).toBe('203.0.113.5');
  });

  it('usa cf-connecting-ip si no hay los headers anteriores', () => {
    const request = { headers: { 'cf-connecting-ip': '203.0.113.9' } };
    expect(resolveClientIp(request)).toBe('203.0.113.9');
  });

  it('usa request.ip cuando no hay headers de proxy', () => {
    const request = { headers: {}, ip: '127.0.0.1' };
    expect(resolveClientIp(request)).toBe('127.0.0.1');
  });

  it('usa request.connection.remoteAddress cuando está disponible', () => {
    const request = {
      headers: {},
      ip: undefined,
      connection: { remoteAddress: '10.0.0.9' },
    };
    expect(resolveClientIp(request)).toBe('10.0.0.9');
  });

  it('bug corregido: no lanza si request.connection es undefined, cae a request.socket.remoteAddress', () => {
    const request: any = {
      headers: {},
      ip: undefined,
      connection: undefined,
      socket: { remoteAddress: '10.0.0.5' },
    };
    expect(() => resolveClientIp(request)).not.toThrow();
    expect(request.clientIp).toBe('10.0.0.5');
  });

  it('bug corregido: no lanza si request.socket también es undefined, cae a request.connection.socket.remoteAddress', () => {
    const request: any = {
      headers: {},
      ip: undefined,
      connection: { socket: { remoteAddress: '10.0.0.20' } },
      socket: undefined,
    };
    expect(() => resolveClientIp(request)).not.toThrow();
    expect(request.clientIp).toBe('10.0.0.20');
  });

  it('retorna UNKNOWN sin lanzar cuando ninguna fuente de IP está disponible', () => {
    const request: any = {
      headers: {},
      ip: undefined,
      connection: undefined,
      socket: undefined,
    };
    expect(() => resolveClientIp(request)).not.toThrow();
    expect(request.clientIp).toBe('UNKNOWN');
  });

  it('deja pasar la petición hacia el siguiente handler', () => {
    const request = { headers: {}, ip: '127.0.0.1' };
    const result$ = interceptor.intercept(buildContext(request), nextHandler);
    expect(result$).toBeDefined();
  });
});

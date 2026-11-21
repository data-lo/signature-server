import {
  INTEGRATION_API_PUBLIC_URL_ENV,
  integrationApiPublicUrl,
} from './integration-api-public-url';

describe('integrationApiPublicUrl', () => {
  const original = process.env[INTEGRATION_API_PUBLIC_URL_ENV];

  afterEach(() => {
    if (original === undefined)
      delete process.env[INTEGRATION_API_PUBLIC_URL_ENV];
    else process.env[INTEGRATION_API_PUBLIC_URL_ENV] = original;
  });

  it.each([undefined, '', '   '])(
    'sin valor (%p) devuelve undefined',
    (value) => {
      if (value === undefined)
        delete process.env[INTEGRATION_API_PUBLIC_URL_ENV];
      else process.env[INTEGRATION_API_PUBLIC_URL_ENV] = value;

      expect(integrationApiPublicUrl()).toBeUndefined();
    },
  );

  it.each([
    [
      'https://signature.api.staging.data-lo.online',
      'https://signature.api.staging.data-lo.online',
    ],
    [
      ' https://signature.api.staging.data-lo.online// ',
      'https://signature.api.staging.data-lo.online',
    ],
    ['http://localhost:3000/', 'http://localhost:3000'],
  ])('normaliza %p a %p', (value, expected) => {
    process.env[INTEGRATION_API_PUBLIC_URL_ENV] = value;

    expect(integrationApiPublicUrl()).toBe(expected);
  });

  it.each([
    'signature.api.staging.data-lo.online',
    'ftp://signature.api.staging.data-lo.online',
    'https://signature.api.staging.data-lo.online/api/v1',
    'https://signature.api.staging.data-lo.online?x=1',
    'https://signature.api.staging.data-lo.online#ref',
  ])('rechaza %p', (value) => {
    process.env[INTEGRATION_API_PUBLIC_URL_ENV] = value;

    expect(() => integrationApiPublicUrl()).toThrow(
      INTEGRATION_API_PUBLIC_URL_ENV,
    );
  });
});

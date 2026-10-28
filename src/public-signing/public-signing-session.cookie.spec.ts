import {
  PUBLIC_SIGNING_SESSION_COOKIE,
  publicSigningSessionCookieOptions,
  readCookie,
} from './public-signing-session.cookie';

describe('public-signing-session.cookie', () => {
  it('la cookie es HttpOnly, Secure, SameSite=Strict y de vida corta', () => {
    expect(publicSigningSessionCookieOptions(1_800_000)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 1_800_000,
    });
  });

  it.each([
    [`a=1; ${PUBLIC_SIGNING_SESSION_COOKIE}=tok.en; b=2`, 'tok.en'],
    [`${PUBLIC_SIGNING_SESSION_COOKIE}=abc%3D`, 'abc='],
    [['a=1', `${PUBLIC_SIGNING_SESSION_COOKIE}=x`], 'x'],
    [`x${PUBLIC_SIGNING_SESSION_COOKIE}=nope`, null],
    [`${PUBLIC_SIGNING_SESSION_COOKIE}=`, null],
    [`${PUBLIC_SIGNING_SESSION_COOKIE}=%E0%A4%A`, null],
    [undefined, null],
  ])('readCookie(%p) → %p', (header, expected) => {
    expect(readCookie(header, PUBLIC_SIGNING_SESSION_COOKIE)).toBe(expected);
  });
});

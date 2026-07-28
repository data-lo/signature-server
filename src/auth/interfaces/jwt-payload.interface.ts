export interface JwtPayload {
  sub: string;
  email: string;
  roles: string[];
  nationalId: string;
  jti: string;
  iat?: number;
  exp?: number;
}

export interface JwtPayload {
  sub: string;
  email: string;
  roles: string[];
  jti: string;
  iat?: number;
  exp?: number;
}

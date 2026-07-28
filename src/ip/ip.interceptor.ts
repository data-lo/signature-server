import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class IpInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const ip = this.getClientIp(request);
    request.clientIp = ip;
    return next.handle();
  }

  private getClientIp(request: any): string {
    if (request.headers['x-forwarded-for']) {
      return request.headers['x-forwarded-for'].split(',')[0].trim();
    }
    if (request.headers['x-client-ip']) {
      return request.headers['x-client-ip'];
    }
    if (request.headers['cf-connecting-ip']) {
      return request.headers['cf-connecting-ip'];
    }
    return (
      request.ip ||
      request.connection.remoteAddress ||
      request.socket.remoteAddress ||
      request.connection.socket.remoteAddress ||
      'UNKNOWN'
    );
  }
}

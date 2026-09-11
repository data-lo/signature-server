import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): { status: string, message: string, version: string } {
    return {
      status: 'online',
      message: 'API de la plataforma de Signature',
      version: '1.0.0'
    };
  }
}

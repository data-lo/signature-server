import { Module } from '@nestjs/common';
import { SignatureService } from './signature.service';

@Module({
    providers: [SignatureService],
    exports: [SignatureService]
})
export class SignatureModule { }

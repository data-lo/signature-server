import { Injectable} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { X509Certificate } from 'crypto';
import { OCSPEvidence } from '../interfaces/OCSPEvidence.interface';
import { getCertStatus } from 'easy-ocsp'
import { OCSPNotAvilableException, CertificadoRevocadoException } from '../efirma.exceptions';

const SAT_OCSP_URL = 'https://cfdi.sat.gob.mx/edofiel';
const SAT_OCSP_TIMEOUT_MS = 5000;

@Injectable()
export class OscpService{
    private readonly logger = new Logger(OscpService.name);
    async verifyRevokedOCSP(
        cerBuffer: Buffer,
        emisor: X509Certificate,
    ): Promise<OCSPEvidence>{
        let result: Awaited<ReturnType<typeof getCertStatus>>;
        this.logger.log('verificado la validez del certifficado');
        try{
            result = await getCertStatus(cerBuffer,{
                ca: emisor.raw,
                ocspUrl: SAT_OCSP_URL,
                timeout: SAT_OCSP_TIMEOUT_MS,
                rawResponse: true,
                enableNonce: false,
            });

        }catch(err){
            this.logger.error(`Fallo en consulta OCSP del certificado en el SAT ${(err as Error).message}`)
            throw new OCSPNotAvilableException((err as Error).message);
        }
        if(result.status ==='revoked'){
            this.logger.warn(`Certificado revocado detectado OCSP: ${cerBuffer.toString('base64').slice(0,20)}`);
            throw new CertificadoRevocadoException(
                (result as any).revocationTime,
                (result as any).revocationReason
            );
        }
        return {
            status: result.status as 'good' | 'unknown',
            verifiedAt: new Date(),
            thisUpdate: result.thisUpdate,
            nextUpdate: result.nextUpdate,
            ocspResponse: (result as any).rawResponse ?
                Buffer.from((result as any).rawResponse).toString('base64')
                : '',
                ocspUrl: SAT_OCSP_URL,
        };
    }
}


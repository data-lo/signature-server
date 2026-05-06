import { OnEvent } from "@nestjs/event-emitter";
import { DocumentService } from "./document.service";

export class VerificationCodeEventService {
    constructor(
        private readonly documentService: DocumentService
    ) { }

    @OnEvent('send.verification.code.email', { async: true })
    async doc(){
        
    }
    // async sendVerificationCodeEmailEvent(payload: VerificationCodeEmailPayload) {
    //     await this.emailService.sendVerificationCodeEmail(
    //         payload.to,
    //         payload.documentName,
    //         payload.signerName,
    //         payload.code,
    //     );
    // }

}
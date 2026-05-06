import { OnEvent } from "@nestjs/event-emitter";
import { EmailService } from "src/shared/email/email.service";
import { VerificationCodeEmailPayload } from "./interfaces/verification-code-email.payload";

export class VerificationCodeEventService {
    constructor(
        private readonly emailService: EmailService
    ) { }

    @OnEvent('send.verification.code.email', { async: true })
    async sendVerificationCodeEmailEvent(payload: VerificationCodeEmailPayload) {
        await this.emailService.sendVerificationCodeEmail(
            payload.to,
            payload.documentName,
            payload.signerName,
            payload.code,
        );
    }

}
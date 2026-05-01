import { Controller, Post, Body } from '@nestjs/common';
import { EmailService } from './email.service';
import { SendEmailDto } from './dto/send-email.dto';

@Controller('email')
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  @Post('send')
  async sendEmail(@Body() sendEmailDto: SendEmailDto): Promise<{ message: string }> {
    await this.emailService.sendEmail(
      sendEmailDto.to,
      sendEmailDto.subject,
      sendEmailDto.html,
      sendEmailDto.from,
    );
    return { message: 'Email sent successfully' };
  }
}
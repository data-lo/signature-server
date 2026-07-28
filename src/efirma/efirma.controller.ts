import { Controller, Post, Body, UseInterceptors, UploadedFiles } from '@nestjs/common';
import { EfirmaService } from './efirma.service';
import { CreateEfirmaDto } from './dto/create-efirma.dto';
import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';
import { FileFieldsInterceptor } from '@nestjs/platform-express';

@SkipJwtAuth()
@Controller('efirma')
export class EfirmaController {
  constructor(
    private readonly efirmaService: EfirmaService) {}

    @Post('sign')
    @UseInterceptors(
      FileFieldsInterceptor([
        {name: 'cerBuffer', maxCount: 1},
        {name: 'keyBuffer', maxCount: 1},
        {name: 'documento', maxCount: 1}
      ])
    )
    signDocumentWithEFirma(
      @Body() createEfirma:CreateEfirmaDto,
      @UploadedFiles() files: {
        cerBuffer?: Express.Multer.File[], 
        keyBuffer?: Express.Multer.File[],
        documento?: Express.Multer.File[]
      }
    ){
      const document = files.documento[0].buffer
      const certificate = files.cerBuffer[0].buffer
      const privateKey = files.keyBuffer[0].buffer
      return this.efirmaService.firmar(document,certificate,privateKey,createEfirma.password);
    }
}

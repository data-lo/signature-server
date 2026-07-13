import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { EfirmaService } from './efirma.service';
import { CreateEfirmaDto } from './dto/create-efirma.dto';
import { UpdateEfirmaDto } from './dto/update-efirma.dto';

@Controller('efirma')
export class EfirmaController {
  constructor(private readonly efirmaService: EfirmaService) {}

 
}

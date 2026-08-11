import { Injectable } from '@nestjs/common';
import { CreateSealDto } from './dto/create-seal.dto';
import { UpdateSealDto } from './dto/update-seal.dto';

@Injectable()
export class SealService {
  create(createSealDto: CreateSealDto) {
    return 'This action adds a new seal';
  }

  findAll() {
    return `This action returns all seal`;
  }

  findOne(id: number) {
    return `This action returns a #${id} seal`;
  }

  update(id: number, updateSealDto: UpdateSealDto) {
    return `This action updates a #${id} seal`;
  }

  remove(id: number) {
    return `This action removes a #${id} seal`;
  }
}

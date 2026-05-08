import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LogEntity } from './entities/log.entity';

@Injectable()
export class LogService {
    constructor(
        @InjectRepository(LogEntity)
        private readonly logRepository: Repository<LogEntity>,
    ) {}

    async write(message: string): Promise<void> {
        const entry = this.logRepository.create({ log: message });
        await this.logRepository.save(entry);
    }
}

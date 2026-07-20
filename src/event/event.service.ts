import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEntity } from './entities/event.entity';
import { EVENT_TYPE_ENUM } from './enums/event-type.enum';

interface CreateEventData {
  eventType: EVENT_TYPE_ENUM;
  metadata?: Record<string, unknown> | null;
  from?: string | null;
}

@Injectable()
export class EventService {
  constructor(
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
  ) {}

  async create(data: CreateEventData): Promise<EventEntity> {
    return this.eventRepository.save(
      this.eventRepository.create({
        eventType: data.eventType,
        metadata: data.metadata ?? null,
        from: data.from ?? null,
      }),
    );
  }
}

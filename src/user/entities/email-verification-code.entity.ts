import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UserEntity } from './user.entity';

/**
 * OTP de verificación de correo de registro (ver historia "Auth: Flujo de Pre-registro,
 * Verificación OTP y Control por CURP") — mismo patrón que
 * src/document/entities/verification-code.entity.ts, pero keyed por usuario en vez de
 * documento/firmante, ya que aquí el propósito es único: verificar que el correo del registro
 * es real antes de activar la cuenta (UserEntity.isEmailVerified).
 */
@Entity('email_verification_codes')
export class EmailVerificationCodeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  code: string;

  @Column({ name: 'is_used', default: false })
  isUsed: boolean;

  @Column({ name: 'used_at', nullable: true })
  usedAt: Date | null;

  @Column({ name: 'expired_at' })
  expiredAt: Date;

  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UserEntity } from '../../user/entities/user.entity';

/**
 * OTP de recuperación de contraseña (ver historia "Recuperación de Contraseña
 * mediante Código de Verificación OTP") — mismo patrón que
 * src/document/entities/verification-code.entity.ts, pero keyed por usuario en vez
 * de documento/firmante, igual que email-verification-code lo hacía para el flujo
 * de registro. Reutiliza el OTPService genérico (src/shared/otp/otp.service.ts).
 */
@Entity('password_reset_codes')
export class PasswordResetCodeEntity {
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

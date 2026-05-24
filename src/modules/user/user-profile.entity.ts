import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

/**
 * Links a user to the profiles they can access.
 * super_admin users skip this table entirely — their access is implicit.
 */
@Entity('user_profiles')
export class UserProfile {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @PrimaryColumn({ name: 'profile_id', type: 'uuid' })
  profileId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

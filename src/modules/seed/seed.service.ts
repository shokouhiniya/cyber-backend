import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UserService } from '../user/user.service';
import { DataSourceService } from '../data-source/data-source.service';
import { Content } from '../content/content.entity';
import { Profile } from '../profile/profile.entity';
import { User } from '../user/user.entity';
import { UserProfile } from '../user/user-profile.entity';

@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly userService: UserService,
    private readonly dataSourceService: DataSourceService,
    private readonly configService: ConfigService,
    @InjectRepository(Content)
    private readonly contentRepository: Repository<Content>,
    @InjectRepository(Profile)
    private readonly profileRepository: Repository<Profile>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserProfile)
    private readonly userProfileRepository: Repository<UserProfile>,
  ) {}

  async onModuleInit() {
    await this.seedDefaultUser();
    await this.seedDataSources();
    await this.seedProfiles();
    await this.seedContent();
    await this.backfillContentProfileId();
    if (process.env.NODE_ENV !== 'production') {
      await this.seedClientAdmin();
    }
    await this.seedGlobalContext();
  }

  /**
   * Bootstrap the first super_admin from BOOTSTRAP_ADMIN_* env vars.
   * Behavior:
   *   - If at least one super_admin exists in DB, skip (env changes do NOT
   *     rotate the admin password — use POST /api/auth/change-password)
   *   - Else if BOOTSTRAP_ADMIN_USERNAME + BOOTSTRAP_ADMIN_PASSWORD are set,
   *     create that user
   *   - Else if NODE_ENV !== 'production', fall back to admin/Admin@123
   *   - Else log an error explaining which vars to set
   */
  private async seedDefaultUser() {
    const existingSuperAdmin = await this.userRepository.findOne({ where: { role: 'super_admin' } });
    if (existingSuperAdmin) {
      this.logger.log(`✓ super_admin موجود: ${existingSuperAdmin.username}`);
      return;
    }

    const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim();
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD?.trim();
    const email    = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() || `${username}@cyberspace.local`;

    if (username && password) {
      const passwordHash = await bcrypt.hash(password, 10);
      await this.userService.create({
        name: 'مدیر سیستم',
        username,
        email,
        passwordHash,
        role: 'super_admin',
      });
      this.logger.log(`✅ super_admin اولیه از .env ساخته شد: ${username} (پس از ورود رمز را تغییر دهید)`);
      return;
    }

    if (process.env.NODE_ENV !== 'production') {
      const passwordHash = await bcrypt.hash('Admin@123', 10);
      await this.userService.create({
        name: 'مدیر سیستم',
        username: 'admin',
        email: 'admin@cyberspace.ir',
        passwordHash,
        role: 'super_admin',
      });
      this.logger.log('✅ کاربر پیش‌فرض ساخته شد (dev): admin / Admin@123');
      return;
    }

    this.logger.error(
      '⚠️ هیچ super_admin در پایگاه داده موجود نیست و BOOTSTRAP_ADMIN_USERNAME/PASSWORD تنظیم نشده‌اند. ' +
      'برای راه‌اندازی اولیه این متغیرها را در .env تنظیم کنید.'
    );
  }

  private async seedDataSources() {
    const existingSources = await this.dataSourceService.findAll();
    if (existingSources.length > 0) return;

    // Phase 1: 8tag is the sole data provider.
    const dataSources = [
      {
        name: 'هشتک (8tag)',
        type: 'news',
        apiEndpoint: process.env.HASHTAG_URL || 'https://d1.8tag.ir',
        credentials: {
          username: process.env.HASHTAG_USERNAME,
          password: process.env.HASHTAG_PASSWORD,
        },
        isActive: true,
      },
    ];

    for (const source of dataSources) {
      await this.dataSourceService.create(source);
    }

    this.logger.log('✅ منبع داده ۸تگ ایجاد شد');
  }

  private async seedProfiles() {
    const existing = await this.profileRepository.count();
    if (existing > 0) {
      // Backfill promtic_identifier for existing profiles if missing
      const profiles = await this.profileRepository.find();
      for (const p of profiles) {
        if (!p.promticIdentifier) {
          p.promticIdentifier = {
            external_id: this.slug(p.name),
            name: p.name,
            type: 'client',
          };
          await this.profileRepository.save(p);
        }
      }
      return;
    }

    const profiles = [
      {
        name: 'محمدباقر قالیباف',
        role: 'رئیس مجلس شورای اسلامی',
        organization: 'مجلس شورای اسلامی',
        keywords: ['قالیباف', 'مجلس', 'رئیس_مجلس'],
        excludedKeywords: [],
        sortCriteria: 'recent',
        plan: 'standard',
        primaryColor: '#1e6091',
        promticIdentifier: {
          external_id: 'ghalibaf',
          name: 'محمدباقر قالیباف — رئیس مجلس شورای اسلامی',
          type: 'political_figure',
        },
        isActive: true,
      },
    ];

    for (const profile of profiles) {
      await this.profileRepository.save(profile);
    }

    this.logger.log('✅ پروفایل پیش‌فرض (قالیباف) ایجاد شد');
  }

  private async seedContent() {
    const existingContent = await this.contentRepository.count();
    if (existingContent > 0) return;

    // Skip seed content here — handled by scripts/demo-seed.sql and import tooling
    // (keeps this method as a migration hook for fresh DBs)
    this.logger.log('پست‌های نمونه از طریق scripts/demo-seed.sql تأمین می‌شوند');
  }

  /**
   * Attaches any existing posts without a profile_id to the first active profile.
   * Safe to run repeatedly.
   */
  private async backfillContentProfileId() {
    const orphan = await this.contentRepository.count({ where: { profileId: IsNull() } });
    if (orphan === 0) return;

    const target = await this.profileRepository.findOne({ where: { isActive: true } });
    if (!target) {
      this.logger.warn(`⚠️ ${orphan} پست بدون profile_id باقی ماند — هیچ پروفایل فعالی وجود ندارد`);
      return;
    }

    await this.contentRepository
      .createQueryBuilder()
      .update()
      .set({ profileId: target.id })
      .where('profile_id IS NULL')
      .execute();

    this.logger.log(`✅ ${orphan} پست به پروفایل "${target.name}" متصل شد`);
  }

  /**
   * Ensures the default profile has a demo client_admin so the role system
   * can be tested without creating an account by hand.
   */
  private async seedClientAdmin() {
    const username = 'client';
    const existing = await this.userService.findByUsername(username);
    if (existing) return;

    const target = await this.profileRepository.findOne({ where: { isActive: true } });
    if (!target) return;

    const passwordHash = await bcrypt.hash('Client@123', 10);
    const user = await this.userService.create({
      name: 'مدیر کلاینت نمونه',
      username,
      email: 'client@cyberspace.ir',
      passwordHash,
      role: 'client_admin',
    });

    await this.userProfileRepository.save({ userId: user.id, profileId: target.id });

    this.logger.log(`✅ client_admin نمونه ساخته شد (dev): ${username} / Client@123 → ${target.name}`);
  }

  private slug(name: string) {
    return name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^\w\u0600-\u06FF_-]/g, '')
      .slice(0, 64) || `profile_${Date.now()}`;
  }

  /**
  /**
   * Seeds default global_context rows only on first-time setup (empty table).
   * Once an admin has customized or deleted rows, we never touch them again.
   */
  private async seedGlobalContext() {
    const [{ count }] = await this.contentRepository.manager.query(
      `SELECT COUNT(*) AS count FROM global_context`,
    );
    if (parseInt(count) > 0) {
      this.logger.log('✓ global_context already populated — skipping seed');
      return;
    }

    const seeds = [
      {
        key: 'political_climate',
        value:
          'فضای سیاسی در شرایط قطبی‌شدگی بالا قرار دارد؛ مذاکرات هسته‌ای و تصمیمات مجلس محور اصلی بحث‌های افکار عمومی هستند.',
      },
      {
        key: 'major_events',
        value:
          'میلاد امام رضا (ع)، بیانیه ۲۶۱ نماینده مجلس، نوسانات قیمت نفت، تنش‌های منطقه‌ای.',
      },
    ];

    for (const seed of seeds) {
      await this.contentRepository.manager.query(
        `INSERT INTO global_context (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [seed.key, seed.value],
      );
    }
    this.logger.log('✅ داده‌های پیش‌فرض global_context ایجاد شد');
  }
}

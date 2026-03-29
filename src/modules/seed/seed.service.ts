import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UserService } from '../user/user.service';

@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  constructor(private readonly userService: UserService) {}

  async onModuleInit() {
    await this.seedDefaultUser();
  }

  private async seedDefaultUser() {
    const email = 'admin@cyberspace.ir';
    const existing = await this.userService.findByEmail(email);

    if (existing) {
      this.logger.log('کاربر پیش‌فرض موجود است');
      return;
    }

    const passwordHash = await bcrypt.hash('Admin@123', 10);

    await this.userService.create({
      name: 'مدیر سیستم',
      email,
      passwordHash,
      role: 'admin',
    });

    this.logger.log('✅ کاربر پیش‌فرض ساخته شد: admin@cyberspace.ir / Admin@123');
  }
}

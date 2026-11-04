import { Global, Module } from '@nestjs/common';

import { SmsService } from './sms.service';

/** Global so auth (OTP) and alerts can inject SmsService without importing it. */
@Global()
@Module({
  providers: [SmsService],
  exports: [SmsService],
})
export class SmsModule {}

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { GhasedakProvider, SmsHttpClient, SmsSendResult } from './ghasedak.provider';
import { maskPhone, normalizeIranPhone } from './phone';

/**
 * - live:     GHASEDAK_API_KEY is set — messages go to Ghasedak.
 * - log:      no key, NODE_ENV is not production and SMS_DEV_LOG=true — the
 *             message (including the OTP code) is written to the server log
 *             instead of being sent. For local testing only.
 * - disabled: no key — nothing is sent; dependent features hide themselves.
 *
 * Log mode needs the explicit SMS_DEV_LOG flag because the deployed API runs
 * with NODE_ENV=development; without the flag a missing key there must mean
 * "disabled", never "print login codes to the container log".
 */
export type SmsMode = 'live' | 'log' | 'disabled';

export const SMS_HTTP_CLIENT = Symbol('SMS_HTTP_CLIENT');

export interface SmsBatchResult {
  ok: boolean;
  sent: number;
  failed: number;
  errors: string[];
  mode: SmsMode;
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  readonly mode: SmsMode;
  private readonly provider: GhasedakProvider | null;
  private readonly otpTemplate: string;

  constructor(
    config: ConfigService,
    @Optional() @Inject(SMS_HTTP_CLIENT) http?: SmsHttpClient,
  ) {
    const apiKey = (config.get<string>('GHASEDAK_API_KEY') || '').trim();
    this.otpTemplate = (config.get<string>('GHASEDAK_OTP_TEMPLATE') || '').trim();
    const devLog =
      String(config.get('SMS_DEV_LOG') || '').toLowerCase() === 'true' &&
      config.get('NODE_ENV') !== 'production';

    if (apiKey) {
      this.mode = 'live';
      this.provider = new GhasedakProvider(
        {
          apiKey,
          baseUrl: (config.get<string>('GHASEDAK_BASE_URL') || '').trim() || undefined,
          otpTemplate: this.otpTemplate || undefined,
          lineNumber: (config.get<string>('GHASEDAK_LINE_NUMBER') || '').trim() || undefined,
          timeoutMs: Number(config.get('GHASEDAK_TIMEOUT_MS')) || undefined,
        },
        http,
      );
      if (!this.otpTemplate) {
        this.logger.warn('GHASEDAK_OTP_TEMPLATE is not set — OTP login and password reset stay off');
      }
    } else {
      this.mode = devLog ? 'log' : 'disabled';
      this.provider = null;
      if (devLog) this.logger.warn('SMS dev-log mode: messages are printed to this log, not sent');
    }
  }

  /** Free-text SMS (alerts) can be sent. */
  get enabled(): boolean {
    return this.mode !== 'disabled';
  }

  /** OTP needs a configured template in live mode. */
  get otpEnabled(): boolean {
    return this.mode === 'log' || (this.mode === 'live' && !!this.otpTemplate);
  }

  async sendOtp(phone: string, code: string): Promise<SmsSendResult> {
    const to = normalizeIranPhone(phone);
    if (!to) return { ok: false, error: 'invalid phone' };
    if (!this.otpEnabled) return { ok: false, error: 'SMS OTP is disabled' };

    if (this.mode === 'log') {
      this.logger.warn(`[SMS dev-log] OTP for ${maskPhone(to)}: ${code}`);
      return { ok: true, messageId: 'dev-log' };
    }
    const res = await this.provider!.sendOtp(to, code);
    if (!res.ok) this.logger.error(res.error);
    return res;
  }

  /** Sends the same text to each phone; one failure doesn't stop the others. */
  async sendText(phones: string[], text: string): Promise<SmsBatchResult> {
    const targets = Array.from(
      new Set((phones || []).map((p) => normalizeIranPhone(p)).filter((p): p is string => !!p)),
    );
    const out: SmsBatchResult = { ok: false, sent: 0, failed: 0, errors: [], mode: this.mode };
    if (!targets.length) {
      out.errors.push('no valid recipient');
      return out;
    }
    if (!this.enabled) {
      out.errors.push('SMS is disabled');
      out.failed = targets.length;
      return out;
    }

    for (const to of targets) {
      if (this.mode === 'log') {
        this.logger.warn(`[SMS dev-log] to ${maskPhone(to)}: ${text}`);
        out.sent++;
        continue;
      }
      const res = await this.provider!.sendText(to, text);
      if (res.ok) out.sent++;
      else {
        out.failed++;
        if (res.error) {
          out.errors.push(res.error);
          this.logger.error(res.error);
        }
      }
    }
    out.ok = out.sent > 0 && out.failed === 0;
    return out;
  }
}

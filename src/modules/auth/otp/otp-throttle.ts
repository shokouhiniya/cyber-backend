import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * In-memory limits for OTP requests and wrong codes (single API instance,
 * like LoginThrottleService). Counted for every phone — registered or not —
 * so the limits themselves don't reveal whether a phone has an account.
 */
export const OTP_LIMITS = {
  /** Minimum gap between two codes to the same phone (per purpose). */
  RESEND_COOLDOWN_MS: 60_000,
  WINDOW_MS: 60 * 60_000,
  /** Codes per phone per hour (all purposes). */
  MAX_PER_PHONE: 5,
  /** Codes per client IP per hour. */
  MAX_PER_IP: 20,
  /** Wrong codes per client IP per hour, across phones. */
  MAX_VERIFY_FAILURES_PER_IP: 30,
} as const;

interface Bucket {
  count: number;
  windowStart: number;
}

export class OtpThrottle {
  private readonly lastSent = new Map<string, number>();
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Throws 429 when a new code may not be sent yet; records the request otherwise. */
  hitRequest(phone: string, purpose: string, ip?: string): void {
    const now = this.now();
    const cooldownKey = `c:${purpose}:${phone}`;
    const last = this.lastSent.get(cooldownKey);
    const wait = last === undefined ? 0 : last + OTP_LIMITS.RESEND_COOLDOWN_MS - now;
    if (wait > 0) {
      throw tooMany(`لطفاً ${fa(Math.ceil(wait / 1000))} ثانیه دیگر دوباره درخواست کد بدهید`, Math.ceil(wait / 1000));
    }
    if (this.count(`p:${phone}`, now) >= OTP_LIMITS.MAX_PER_PHONE) {
      throw tooMany('تعداد درخواست کد برای این شماره زیاد است. لطفاً یک ساعت دیگر تلاش کنید');
    }
    if (ip && this.count(`ip:${ip}`, now) >= OTP_LIMITS.MAX_PER_IP) {
      throw tooMany('تعداد درخواست‌ها زیاد است. لطفاً بعداً تلاش کنید');
    }
    this.lastSent.set(cooldownKey, now);
    this.bump(`p:${phone}`, now);
    if (ip) this.bump(`ip:${ip}`, now);
    this.prune(now);
  }

  assertVerifyAllowed(ip?: string): void {
    if (ip && this.count(`vf:${ip}`, this.now()) >= OTP_LIMITS.MAX_VERIFY_FAILURES_PER_IP) {
      throw tooMany('تلاش‌های ناموفق زیاد بوده است. لطفاً بعداً تلاش کنید');
    }
  }

  recordVerifyFailure(ip?: string): void {
    if (ip) this.bump(`vf:${ip}`, this.now());
  }

  private count(key: string, now: number): number {
    const b = this.buckets.get(key);
    if (!b || now - b.windowStart > OTP_LIMITS.WINDOW_MS) return 0;
    return b.count;
  }

  private bump(key: string, now: number) {
    let b = this.buckets.get(key);
    if (!b || now - b.windowStart > OTP_LIMITS.WINDOW_MS) {
      b = { count: 0, windowStart: now };
      this.buckets.set(key, b);
    }
    b.count++;
  }

  private prune(now: number) {
    if (this.buckets.size + this.lastSent.size < 2000) return;
    for (const [k, b] of this.buckets) if (now - b.windowStart > OTP_LIMITS.WINDOW_MS) this.buckets.delete(k);
    for (const [k, t] of this.lastSent) if (now - t > OTP_LIMITS.RESEND_COOLDOWN_MS) this.lastSent.delete(k);
  }
}

const fa = (n: number) => n.toLocaleString('fa-IR');

function tooMany(message: string, retryAfterSeconds?: number) {
  return new HttpException(
    { statusCode: 429, message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

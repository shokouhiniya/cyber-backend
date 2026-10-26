import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

interface Attempts {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

/**
 * Brute-force protection for sign-in.
 *
 * Failed attempts are counted per username and per client IP inside a
 * sliding window. Once a key reaches its limit it is locked for LOCK_MS.
 * A successful sign-in clears the username's counter.
 *
 * State is in memory — fine for the single API instance this runs as;
 * a restart simply resets the counters.
 */
@Injectable()
export class LoginThrottleService {
  static readonly WINDOW_MS = 15 * 60_000;
  static readonly LOCK_MS = 15 * 60_000;
  static readonly MAX_PER_USER = 5;
  static readonly MAX_PER_IP = 20;

  private readonly attempts = new Map<string, Attempts>();

  /** Throws 429 if either the username or the IP is currently locked. */
  assertAllowed(username: string, ip: string | undefined): void {
    const now = Date.now();
    const lockedUntil = Math.max(
      this.lockedUntil(this.userKey(username), now),
      ip ? this.lockedUntil(this.ipKey(ip), now) : 0,
    );
    if (lockedUntil > now) {
      const minutes = Math.ceil((lockedUntil - now) / 60_000);
      throw new HttpException(
        `به دلیل تلاش‌های ناموفق متعدد، ورود موقتاً مسدود شده است. لطفاً ${minutes.toLocaleString('fa-IR')} دقیقه دیگر تلاش کنید`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  recordFailure(username: string, ip: string | undefined): void {
    const now = Date.now();
    this.bump(this.userKey(username), LoginThrottleService.MAX_PER_USER, now);
    if (ip) this.bump(this.ipKey(ip), LoginThrottleService.MAX_PER_IP, now);
    this.prune(now);
  }

  recordSuccess(username: string): void {
    this.attempts.delete(this.userKey(username));
  }

  private userKey(username: string) {
    return `u:${(username || '').trim().toLowerCase()}`;
  }

  private ipKey(ip: string) {
    return `ip:${ip}`;
  }

  private lockedUntil(key: string, now: number): number {
    const a = this.attempts.get(key);
    return a && a.lockedUntil > now ? a.lockedUntil : 0;
  }

  private bump(key: string, max: number, now: number) {
    let a = this.attempts.get(key);
    if (!a || now - a.windowStart > LoginThrottleService.WINDOW_MS) {
      a = { failures: 0, windowStart: now, lockedUntil: 0 };
      this.attempts.set(key, a);
    }
    a.failures += 1;
    if (a.failures >= max) {
      a.lockedUntil = now + LoginThrottleService.LOCK_MS;
      a.failures = 0;
      a.windowStart = now;
    }
  }

  /** Drop stale entries so the map can't grow without bound. */
  private prune(now: number) {
    if (this.attempts.size < 1000) return;
    for (const [key, a] of this.attempts) {
      if (a.lockedUntil <= now && now - a.windowStart > LoginThrottleService.WINDOW_MS) {
        this.attempts.delete(key);
      }
    }
  }
}

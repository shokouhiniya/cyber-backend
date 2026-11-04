import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';

import { SmsService, maskPhone, normalizeIranPhone, toLatinDigits } from '../../../libs/sms';
import { AdminAuditLog } from '../../admin/audit-log/admin-audit-log.entity';
import { User } from '../../user/user.entity';
import { UserService } from '../../user/user.service';
import { OtpThrottle, OTP_LIMITS } from './otp-throttle';

export type OtpPurpose = 'login' | 'reset';

export const OTP_TTL_MS = 2 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;

/** Same text whatever went wrong, so the reply never tells phones apart. */
export const OTP_INVALID_MESSAGE = 'کد وارد شده نادرست یا منقضی شده است';

export interface OtpRequestResult {
  /** Always true: the reply is identical whether or not the phone has an account. */
  accepted: true;
  expiresInSeconds: number;
  resendInSeconds: number;
  codeLength: number;
}

interface OtpRow {
  id: string;
  user_id: string | null;
  code_hash: string;
  attempts: number;
}

/**
 * One-time SMS codes for phone sign-in and password reset.
 *
 * - 5 or 6 digits (OTP_CODE_LENGTH, default 5), valid 2 minutes, at most 5
 *   wrong attempts, single use. Only an HMAC of the code is stored.
 * - A new code replaces any earlier unused one for the same phone + purpose.
 * - Request replies don't depend on whether the phone belongs to an active
 *   account: the SMS is sent in the background and the limits count every phone.
 * - Every request / send / verify / failure is written to admin_audit_log
 *   with the phone masked.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly hmacKey: string;
  readonly codeLength: number;
  readonly throttle: OtpThrottle;

  constructor(
    @InjectRepository(AdminAuditLog) private readonly audit: Repository<AdminAuditLog>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly users: UserService,
    private readonly sms: SmsService,
    config: ConfigService,
  ) {
    this.hmacKey = `${config.get('jwt')?.secret || 'default-secret'}::otp`;
    this.codeLength = Number(config.get('OTP_CODE_LENGTH')) === 6 ? 6 : 5;
    this.throttle = new OtpThrottle();
  }

  get enabled(): boolean {
    return this.sms.otpEnabled;
  }

  async request(rawPhone: string, purpose: OtpPurpose, ip?: string, userAgent?: string): Promise<OtpRequestResult> {
    if (!this.enabled) throw new ServiceUnavailableException('ارسال پیامک در این سامانه فعال نیست');
    const phone = this.phoneOrThrow(rawPhone);

    try {
      this.throttle.hitRequest(phone, purpose, ip);
    } catch (err) {
      await this.log('auth.otp.rate_limited', { phone, purpose, ip, userAgent });
      throw err;
    }

    const result: OtpRequestResult = {
      accepted: true,
      expiresInSeconds: OTP_TTL_MS / 1000,
      resendInSeconds: OTP_LIMITS.RESEND_COOLDOWN_MS / 1000,
      codeLength: this.codeLength,
    };

    const user = await this.users.findByPhone(phone);
    if (!user || !user.isActive) {
      await this.log('auth.otp.requested_unknown', { phone, purpose, ip, userAgent });
      return result;
    }

    const code = this.generateCode();
    await this.audit.query(
      `UPDATE auth_otp_codes SET consumed_at = NOW()
       WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL`,
      [phone, purpose],
    );
    const rows: Array<{ id: string }> = await this.audit.query(
      `INSERT INTO auth_otp_codes (phone, purpose, user_id, code_hash, expires_at, ip)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' milliseconds')::interval, $6)
       RETURNING id`,
      [phone, purpose, user.id, this.hash(phone, purpose, code), String(OTP_TTL_MS), ip ?? null],
    );
    await this.log('auth.otp.requested', { phone, purpose, ip, userAgent, userId: user.id, otpId: rows[0]?.id });

    // Not awaited: the reply time must not reveal that a real SMS is being sent
    void this.sms
      .sendOtp(phone, code)
      .then((res) =>
        this.log(res.ok ? 'auth.otp.sent' : 'auth.otp.send_failed', {
          phone,
          purpose,
          ip,
          userId: user.id,
          otpId: rows[0]?.id,
          error: res.ok ? undefined : res.error,
        }),
      )
      .catch((err) => this.logger.error(`OTP send crashed for ${maskPhone(phone)}: ${err?.message}`));

    return result;
  }

  /**
   * Checks and consumes a code. Returns the user it was sent to; throws 401
   * with OTP_INVALID_MESSAGE for any mismatch (unknown phone, wrong, expired,
   * used, locked).
   */
  async verify(rawPhone: string, rawCode: string, purpose: OtpPurpose, ip?: string, userAgent?: string): Promise<User> {
    if (!this.enabled) throw new ServiceUnavailableException('ارسال پیامک در این سامانه فعال نیست');
    const phone = this.phoneOrThrow(rawPhone);
    const code = toLatinDigits(String(rawCode ?? '')).replace(/\D/g, '');
    this.throttle.assertVerifyAllowed(ip);

    const fail = async (reason: string, extra: Record<string, any> = {}) => {
      this.throttle.recordVerifyFailure(ip);
      await this.log('auth.otp.failed', { phone, purpose, ip, userAgent, reason, ...extra });
      return new UnauthorizedException(OTP_INVALID_MESSAGE);
    };

    if (code.length !== this.codeLength) throw await fail('malformed');

    const rows: OtpRow[] = await this.audit.query(
      `SELECT id, user_id, code_hash, attempts FROM auth_otp_codes
       WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [phone, purpose],
    );
    const row = rows[0];
    if (!row) throw await fail('no_active_code');
    if (row.attempts >= OTP_MAX_ATTEMPTS) throw await fail('locked', { otpId: row.id });

    if (!this.matches(row.code_hash, this.hash(phone, purpose, code))) {
      const updated = await this.audit.query(
        `UPDATE auth_otp_codes
         SET attempts = attempts + 1,
             consumed_at = CASE WHEN attempts + 1 >= $2 THEN NOW() ELSE consumed_at END
         WHERE id = $1 RETURNING attempts`,
        [row.id, OTP_MAX_ATTEMPTS],
      );
      const attempts = Number(rowsOf(updated)[0]?.attempts ?? row.attempts + 1);
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await this.log('auth.otp.locked', { phone, purpose, ip, userId: row.user_id, otpId: row.id });
      }
      throw await fail('wrong_code', { otpId: row.id, attempts, userId: row.user_id });
    }

    // Atomic consume: a parallel verify of the same code can't both succeed
    const consumed = await this.audit.query(
      `UPDATE auth_otp_codes SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
      [row.id],
    );
    if (!rowsOf(consumed).length) throw await fail('already_used', { otpId: row.id });

    const user = row.user_id ? await this.users.findById(row.user_id) : null;
    if (!user || !user.isActive || user.phone !== phone) {
      throw await fail('account_unavailable', { otpId: row.id });
    }
    if (!user.phoneVerifiedAt) {
      await this.userRepo.update(user.id, { phoneVerifiedAt: new Date() });
    }
    await this.log('auth.otp.verified', { phone, purpose, ip, userAgent, userId: user.id, otpId: row.id });
    return user;
  }

  /** Audit helper usable by the controller for follow-up events (password reset). */
  async log(
    action: string,
    data: { phone?: string; purpose?: string; ip?: string; userAgent?: string; userId?: string | null } & Record<
      string,
      any
    >,
  ): Promise<void> {
    const { phone, ip, userAgent, userId, ...rest } = data;
    const diff: Record<string, any> = { ...rest };
    if (phone) diff.phone = maskPhone(phone);
    for (const k of Object.keys(diff)) if (diff[k] === undefined) delete diff[k];
    try {
      await this.audit.save(
        this.audit.create({
          action,
          entityType: 'auth',
          entityId: userId ?? undefined,
          userId: userId ?? undefined,
          diff,
          ip: ip ? String(ip).slice(0, 64) : undefined,
          userAgent: userAgent ? String(userAgent).slice(0, 500) : undefined,
        }),
      );
    } catch (err: any) {
      this.logger.warn(`OTP audit write failed (${action}): ${err?.message}`);
    }
  }

  private phoneOrThrow(raw: string): string {
    const phone = normalizeIranPhone(raw);
    if (!phone) throw new BadRequestException('شماره موبایل معتبر نیست (مثال: ۰۹۱۲۱۲۳۴۵۶۷)');
    return phone;
  }

  private generateCode(): string {
    const min = 10 ** (this.codeLength - 1);
    return String(randomInt(min, 10 ** this.codeLength));
  }

  private hash(phone: string, purpose: string, code: string): string {
    return createHmac('sha256', this.hmacKey).update(`${phone}:${purpose}:${code}`).digest('hex');
  }

  private matches(a: string, b: string): boolean {
    const x = Buffer.from(String(a), 'hex');
    const y = Buffer.from(String(b), 'hex');
    return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
  }
}

/** TypeORM's pg driver returns [rows, count] for UPDATE … RETURNING, plain rows otherwise. */
function rowsOf(result: any): any[] {
  if (!Array.isArray(result)) return [];
  return Array.isArray(result[0]) ? result[0] : result;
}

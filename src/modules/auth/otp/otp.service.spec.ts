import { HttpException, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { OtpService, OTP_INVALID_MESSAGE, OTP_MAX_ATTEMPTS } from './otp.service';
import { OtpThrottle, OTP_LIMITS } from './otp-throttle';
import { AuthSessionService } from '../auth-session.service';

/**
 * In-memory stand-in for the auth_otp_codes SQL the service runs, so the
 * whole request → verify flow is exercised without a database.
 */
function fakeDb() {
  const codes: any[] = [];
  const audit: any[] = [];
  let seq = 0;
  const query = jest.fn(async (sql: string, p: any[]) => {
    const now = Date.now();
    if (sql.startsWith('UPDATE auth_otp_codes SET consumed_at = NOW()\n       WHERE phone')) {
      codes.filter((c) => c.phone === p[0] && c.purpose === p[1] && !c.consumed_at).forEach((c) => (c.consumed_at = now));
      return [[], 0];
    }
    if (sql.startsWith('INSERT INTO auth_otp_codes')) {
      const row = { id: `otp-${++seq}`, phone: p[0], purpose: p[1], user_id: p[2], code_hash: p[3], expires_at: now + Number(p[4]), attempts: 0, consumed_at: null, created_at: now + seq };
      codes.push(row);
      return [{ id: row.id }];
    }
    if (sql.startsWith('SELECT id, user_id, code_hash, attempts FROM auth_otp_codes')) {
      return codes
        .filter((c) => c.phone === p[0] && c.purpose === p[1] && !c.consumed_at && c.expires_at > now)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 1);
    }
    if (sql.includes('SET attempts = attempts + 1')) {
      const c = codes.find((x) => x.id === p[0]);
      c.attempts++;
      if (c.attempts >= p[1]) c.consumed_at = now;
      return [[{ attempts: c.attempts }], 1];
    }
    if (sql.startsWith('UPDATE auth_otp_codes SET consumed_at = NOW() WHERE id')) {
      const c = codes.find((x) => x.id === p[0] && !x.consumed_at);
      if (c) c.consumed_at = now;
      return [c ? [{ id: c.id }] : [], c ? 1 : 0];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const repo = {
    query,
    create: (x: any) => x,
    save: jest.fn(async (x: any) => audit.push(x)),
  };
  return { codes, audit, repo };
}

const USER = { id: 'u1', username: 'ali', role: 'client_viewer', isActive: true, phone: '09121234567', phoneVerifiedAt: null };

function setup(opts: { otpEnabled?: boolean; user?: any } = {}) {
  const db = fakeDb();
  const sent: Array<{ phone: string; code: string }> = [];
  const sms = {
    otpEnabled: opts.otpEnabled ?? true,
    sendOtp: jest.fn(async (phone: string, code: string) => {
      sent.push({ phone, code });
      return { ok: true };
    }),
  };
  const user = opts.user === undefined ? { ...USER } : opts.user;
  const users = {
    findByPhone: jest.fn(async (p: string) => (user && user.phone === p ? user : null)),
    findById: jest.fn(async (id: string) => (user && user.id === id ? user : null)),
  };
  const userRepo = { update: jest.fn(async () => undefined) };
  const config = { get: (k: string) => (k === 'jwt' ? { secret: 's3cret' } : undefined) };
  const svc = new OtpService(db.repo as any, userRepo as any, users as any, sms as any, config as any);
  return { svc, db, sms, sent, users, userRepo };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('OtpService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('sends a 5-digit code, stores only its hash and signs the user in', async () => {
    const { svc, db, sent, userRepo } = setup();
    const res = await svc.request('+989121234567', 'login', '1.1.1.1');
    expect(res).toEqual({ accepted: true, expiresInSeconds: 120, resendInSeconds: 60, codeLength: 5 });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].code).toMatch(/^\d{5}$/);
    expect(db.codes[0].code_hash).not.toContain(sent[0].code);
    expect(db.codes[0].code_hash).toMatch(/^[0-9a-f]{64}$/);

    // Persian digits in the code are accepted
    const fa = sent[0].code.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
    const user = await svc.verify('09121234567', fa, 'login', '1.1.1.1');
    expect(user.id).toBe('u1');
    expect(userRepo.update).toHaveBeenCalledWith('u1', { phoneVerifiedAt: expect.any(Date) });
    // single use
    await expect(svc.verify('09121234567', sent[0].code, 'login')).rejects.toThrow(OTP_INVALID_MESSAGE);
    expect(db.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['auth.otp.requested', 'auth.otp.sent', 'auth.otp.verified', 'auth.otp.failed']),
    );
    // phone is masked in the audit trail
    expect(JSON.stringify(db.audit)).not.toContain('09121234567');
  });

  it('answers identically for an unknown phone and sends nothing', async () => {
    const known = setup();
    const unknown = setup({ user: null });
    const a = await known.svc.request('09121234567', 'login');
    const b = await unknown.svc.request('09121234567', 'login');
    expect(b).toEqual(a);
    await flush();
    expect(unknown.sms.sendOtp).not.toHaveBeenCalled();
    expect(unknown.db.audit[0].action).toBe('auth.otp.requested_unknown');
    await expect(unknown.svc.verify('09121234567', '12345', 'login')).rejects.toThrow(OTP_INVALID_MESSAGE);
  });

  it('does not send to inactive accounts', async () => {
    const { svc, sms } = setup({ user: { ...USER, isActive: false } });
    await svc.request('09121234567', 'login');
    await flush();
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it('burns the code after 5 wrong attempts', async () => {
    const { svc, sent, db } = setup();
    await svc.request('09121234567', 'login');
    await flush();
    const wrong = sent[0].code === '11111' ? '22222' : '11111';
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      await expect(svc.verify('09121234567', wrong, 'login')).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(svc.verify('09121234567', sent[0].code, 'login')).rejects.toThrow(OTP_INVALID_MESSAGE);
    expect(db.audit.some((a) => a.action === 'auth.otp.locked')).toBe(true);
  });

  it('expires codes after 2 minutes', async () => {
    const { svc, sent, db } = setup();
    await svc.request('09121234567', 'login');
    await flush();
    db.codes[0].expires_at = Date.now() - 1;
    await expect(svc.verify('09121234567', sent[0].code, 'login')).rejects.toThrow(OTP_INVALID_MESSAGE);
  });

  it('keeps login and reset codes apart', async () => {
    const { svc, sent } = setup();
    await svc.request('09121234567', 'reset');
    await flush();
    await expect(svc.verify('09121234567', sent[0].code, 'login')).rejects.toThrow(OTP_INVALID_MESSAGE);
    await expect(svc.verify('09121234567', sent[0].code, 'reset')).resolves.toMatchObject({ id: 'u1' });
  });

  it('enforces the 60-second resend cooldown', async () => {
    const { svc, db } = setup();
    await svc.request('09121234567', 'login');
    await expect(svc.request('09121234567', 'login')).rejects.toBeInstanceOf(HttpException);
    expect(db.audit.some((a) => a.action === 'auth.otp.rate_limited')).toBe(true);
  });

  it('refuses everything when SMS OTP is disabled', async () => {
    const { svc } = setup({ otpEnabled: false });
    await expect(svc.request('09121234567', 'login')).rejects.toMatchObject({ status: 503 });
  });

  it('rejects malformed phones', async () => {
    const { svc } = setup();
    await expect(svc.request('12345', 'login')).rejects.toMatchObject({ status: 400 });
  });
});

describe('OtpThrottle', () => {
  it('limits per phone and per IP within the hour', () => {
    let now = 0;
    const t = new OtpThrottle(() => now);
    for (let i = 0; i < OTP_LIMITS.MAX_PER_PHONE; i++) {
      t.hitRequest('09121234567', 'login', `ip${i}`);
      now += OTP_LIMITS.RESEND_COOLDOWN_MS;
    }
    expect(() => t.hitRequest('09121234567', 'login', 'ipX')).toThrow(HttpException);
    now += OTP_LIMITS.WINDOW_MS + 1;
    expect(() => t.hitRequest('09121234567', 'login', 'ipX')).not.toThrow();

    const t2 = new OtpThrottle(() => now);
    for (let i = 0; i < OTP_LIMITS.MAX_PER_IP; i++) t2.hitRequest(`0912000${String(i).padStart(4, '0')}`, 'login', 'same-ip');
    expect(() => t2.hitRequest('09359999999', 'login', 'same-ip')).toThrow(HttpException);
  });
});

describe('AuthSessionService', () => {
  const jwt = new JwtService({ secret: 's3cret', signOptions: { expiresIn: '60m' } });
  const config = { get: (k: string) => (k === 'jwt' ? { secret: 's3cret' } : undefined) } as any;
  const user: any = { id: 'u1', username: 'ali', role: 'client_viewer', isActive: true, passwordChangedAt: null };
  const users: any = { findById: jest.fn(async () => user) };
  const svc = new AuthSessionService(jwt, users, config);

  it('issues a refresh token only with remember-me, valid for 30 days', () => {
    expect(svc.issue(user).refreshToken).toBeUndefined();
    const t = svc.issue(user, true);
    const p: any = jwt.decode(t.refreshToken!);
    expect(p.exp - p.iat).toBe(30 * 86400);
  });

  it('refresh tokens are not valid access tokens (different secret)', () => {
    const { refreshToken } = svc.issue(user, true);
    expect(() => jwt.verify(refreshToken!)).toThrow();
  });

  it('refreshes while the password is unchanged, then revokes after a change', async () => {
    const { refreshToken } = svc.issue(user, true);
    await expect(svc.refresh(refreshToken!)).resolves.toHaveProperty('accessToken');
    user.passwordChangedAt = new Date(Date.now() + 2000);
    await expect(svc.refresh(refreshToken!)).rejects.toBeInstanceOf(UnauthorizedException);
    user.passwordChangedAt = null;
    user.isActive = false;
    await expect(svc.refresh(refreshToken!)).rejects.toBeInstanceOf(UnauthorizedException);
    user.isActive = true;
  });

  it('reset tokens can not be used as refresh tokens', async () => {
    const reset = svc.resetToken(user);
    await expect(svc.refresh(reset)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.userForResetToken(reset)).resolves.toBe(user);
  });
});

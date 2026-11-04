import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SmsService } from './sms.service';
import { GhasedakProvider, SmsHttpClient } from './ghasedak.provider';
import { maskPhone, normalizeIranPhone } from './phone';

const config = (env: Record<string, string | undefined>) =>
  ({ get: (k: string) => env[k] }) as unknown as ConfigService;

const okHttp = () => {
  const post = jest.fn().mockResolvedValue({ status: 200, data: { result: { code: 200, message: 'success' }, items: [123] } });
  return { post } as unknown as SmsHttpClient & { post: jest.Mock };
};

describe('normalizeIranPhone', () => {
  it.each([
    ['09121234567', '09121234567'],
    ['9121234567', '09121234567'],
    ['+989121234567', '09121234567'],
    ['00989121234567', '09121234567'],
    ['989121234567', '09121234567'],
    ['۰۹۱۲۱۲۳۴۵۶۷', '09121234567'],
    ['٠٩١٢١٢٣٤٥٦٧', '09121234567'],
    ['0912 123-4567', '09121234567'],
    ['+98 (912) 123 4567', '09121234567'],
  ])('%s → %s', (input, out) => expect(normalizeIranPhone(input)).toBe(out));

  it.each(['', null, undefined, '02112345678', '0912123456', '091212345678', 'abc', '+19121234567'])(
    'rejects %p',
    (input) => expect(normalizeIranPhone(input as any)).toBeNull(),
  );

  it('masks phones', () => expect(maskPhone('09121234567')).toBe('0912***4567'));
});

describe('SmsService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('is disabled without a key, even in development', async () => {
    const http = okHttp();
    const sms = new SmsService(config({ NODE_ENV: 'development' }), http);
    expect(sms.mode).toBe('disabled');
    expect(sms.enabled).toBe(false);
    expect(sms.otpEnabled).toBe(false);
    expect((await sms.sendOtp('09121234567', '12345')).ok).toBe(false);
    expect((await sms.sendText(['09121234567'], 'x')).ok).toBe(false);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('logs instead of sending in dev-log mode', async () => {
    const http = okHttp();
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const sms = new SmsService(config({ NODE_ENV: 'development', SMS_DEV_LOG: 'true' }), http);
    expect(sms.mode).toBe('log');
    expect(sms.otpEnabled).toBe(true);
    expect((await sms.sendOtp('+989121234567', '48213')).ok).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('48213'));
    expect(http.post).not.toHaveBeenCalled();
  });

  it('never uses dev-log mode in production', () => {
    const sms = new SmsService(config({ NODE_ENV: 'production', SMS_DEV_LOG: 'true' }));
    expect(sms.mode).toBe('disabled');
  });

  it('sends OTP through the Ghasedak template endpoint', async () => {
    const http = okHttp();
    const sms = new SmsService(
      config({ GHASEDAK_API_KEY: 'secret-key', GHASEDAK_OTP_TEMPLATE: 'sadeghotp' }),
      http,
    );
    expect(sms.mode).toBe('live');
    const res = await sms.sendOtp('۰۹۱۲۱۲۳۴۵۶۷', '123456');
    expect(res).toEqual({ ok: true, messageId: '123' });
    const [url, body] = http.post.mock.calls[0];
    expect(url).toBe('v2/verification/send/simple');
    expect(Object.fromEntries(body as URLSearchParams)).toEqual({
      receptor: '09121234567',
      type: '1',
      template: 'sadeghotp',
      param1: '123456',
    });
  });

  it('keeps OTP off when the template is missing', async () => {
    const sms = new SmsService(config({ GHASEDAK_API_KEY: 'k' }), okHttp());
    expect(sms.enabled).toBe(true);
    expect(sms.otpEnabled).toBe(false);
  });

  it('sends free text with the line number to every unique valid phone', async () => {
    const http = okHttp();
    const sms = new SmsService(
      config({ GHASEDAK_API_KEY: 'k', GHASEDAK_LINE_NUMBER: '30005088' }),
      http,
    );
    const res = await sms.sendText(['09121234567', '+989121234567', 'bad', '09351112233'], 'هشدار');
    expect(res).toMatchObject({ ok: true, sent: 2, failed: 0 });
    expect(http.post).toHaveBeenCalledTimes(2);
    const [url, body] = http.post.mock.calls[0];
    expect(url).toBe('v2/sms/send/simple');
    expect(Object.fromEntries(body as URLSearchParams)).toEqual({
      receptor: '09121234567',
      message: 'هشدار',
      linenumber: '30005088',
    });
  });

  it('reports Ghasedak errors without leaking the API key', async () => {
    const post = jest
      .fn()
      .mockRejectedValueOnce({
        response: { status: 401, data: { result: { code: 401, message: 'apikey invalid' } } },
        config: { headers: { apikey: 'super-secret' } },
      })
      .mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 8000ms exceeded' });
    const error = jest.spyOn(Logger.prototype, 'error');
    const sms = new SmsService(config({ GHASEDAK_API_KEY: 'super-secret' }), { post } as any);
    const res = await sms.sendText(['09121234567', '09351112233'], 'x');
    expect(res).toMatchObject({ ok: false, sent: 0, failed: 2 });
    expect(res.errors[0]).toContain('HTTP 401');
    expect(res.errors[1]).toContain('timeout');
    const logged = JSON.stringify(error.mock.calls) + JSON.stringify(res);
    expect(logged).not.toContain('super-secret');
    expect(logged).not.toContain('09121234567');
  });

  it('treats a non-200 result code as failure', async () => {
    const http = { post: jest.fn().mockResolvedValue({ status: 200, data: { result: { code: 418, message: 'no credit' } } }) };
    const p = new GhasedakProvider({ apiKey: 'k', otpTemplate: 't' }, http);
    const res = await p.sendOtp('09121234567', '1');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no credit');
  });

  it('configures a timeout on the default HTTP client', () => {
    const p = new GhasedakProvider({ apiKey: 'k' }) as any;
    expect(p.http.defaults.timeout).toBe(8000);
    expect(p.http.defaults.baseURL).toBe('https://api.ghasedak.me');
  });
});

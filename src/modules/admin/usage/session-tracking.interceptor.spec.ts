import { lastValueFrom, of } from 'rxjs';

import { SessionTrackingInterceptor } from './session-tracking.interceptor';

function setup() {
  const sessions = { start: jest.fn(async () => undefined), touch: jest.fn(async () => true) };
  const jwt = { decode: jest.fn(() => ({ sub: 'u1' })) };
  const interceptor = new SessionTrackingInterceptor(sessions as any, jwt as any);
  const run = async (req: any, body: any = {}) => {
    const ctx = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) } as any;
    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(body) }));
    await Promise.resolve();
  };
  return { sessions, run };
}

describe('SessionTrackingInterceptor', () => {
  it('a sign-in response opens a session (wrapped { meta, data } body)', async () => {
    const { sessions, run } = setup();
    await run({ method: 'POST', originalUrl: '/api/auth/sign-in', headers: {} }, { meta: {}, data: { accessToken: 't' } });
    expect(sessions.start).toHaveBeenCalledWith('u1', expect.anything());
    expect(sessions.touch).not.toHaveBeenCalled();
  });

  it('an OTP sign-in opens a session too', async () => {
    const { sessions, run } = setup();
    await run({ method: 'POST', originalUrl: '/api/auth/otp/sign-in', headers: {} }, { accessToken: 't' });
    expect(sessions.start).toHaveBeenCalledTimes(1);
  });

  it('a token refresh is activity, not a new login', async () => {
    const { sessions, run } = setup();
    await run({ method: 'POST', originalUrl: '/api/auth/refresh', headers: {} }, { data: { accessToken: 't' } });
    expect(sessions.start).not.toHaveBeenCalled();
    expect(sessions.touch).toHaveBeenCalledWith('u1', expect.anything());
  });

  it('a failed sign-in (no token) does nothing', async () => {
    const { sessions, run } = setup();
    await run({ method: 'POST', originalUrl: '/api/auth/sign-in', headers: {} }, { message: 'bad' });
    expect(sessions.start).not.toHaveBeenCalled();
  });

  it('an authenticated request touches the session', async () => {
    const { sessions, run } = setup();
    await run({ method: 'GET', originalUrl: '/api/stats', headers: {}, user: { sub: 'u2' } });
    expect(sessions.touch).toHaveBeenCalledWith('u2', expect.anything());
  });

  it('sign-out does not re-open the session it closes', async () => {
    const { sessions, run } = setup();
    await run({ method: 'POST', originalUrl: '/api/usage/sessions/end', headers: {}, user: { sub: 'u2' } });
    expect(sessions.touch).not.toHaveBeenCalled();
  });

  it('anonymous requests are ignored', async () => {
    const { sessions, run } = setup();
    await run({ method: 'GET', originalUrl: '/api/auth/capabilities', headers: {} });
    expect(sessions.touch).not.toHaveBeenCalled();
    expect(sessions.start).not.toHaveBeenCalled();
  });
});

import { HttpException } from '@nestjs/common';
import { LoginThrottleService } from './login-throttle.service';

describe('LoginThrottleService', () => {
  let service: LoginThrottleService;

  beforeEach(() => {
    service = new LoginThrottleService();
  });

  it('locks a username after MAX_PER_USER failures', () => {
    for (let i = 0; i < LoginThrottleService.MAX_PER_USER; i++) {
      expect(() => service.assertAllowed('admin', '1.1.1.1')).not.toThrow();
      service.recordFailure('admin', '1.1.1.1');
    }
    expect(() => service.assertAllowed('admin', '2.2.2.2')).toThrow(HttpException);
  });

  it('treats usernames case-insensitively', () => {
    for (let i = 0; i < LoginThrottleService.MAX_PER_USER; i++) {
      service.recordFailure('Admin', undefined);
    }
    expect(() => service.assertAllowed('admin', undefined)).toThrow(HttpException);
  });

  it('does not lock other usernames', () => {
    for (let i = 0; i < LoginThrottleService.MAX_PER_USER; i++) {
      service.recordFailure('admin', '1.1.1.1');
    }
    expect(() => service.assertAllowed('client', '2.2.2.2')).not.toThrow();
  });

  it('locks an IP after MAX_PER_IP failures across usernames', () => {
    for (let i = 0; i < LoginThrottleService.MAX_PER_IP; i++) {
      service.recordFailure(`user${i}`, '9.9.9.9');
    }
    expect(() => service.assertAllowed('someone-new', '9.9.9.9')).toThrow(HttpException);
    expect(() => service.assertAllowed('someone-new', '8.8.8.8')).not.toThrow();
  });

  it('clears the username counter on success', () => {
    for (let i = 0; i < LoginThrottleService.MAX_PER_USER - 1; i++) {
      service.recordFailure('admin', undefined);
    }
    service.recordSuccess('admin');
    service.recordFailure('admin', undefined);
    expect(() => service.assertAllowed('admin', undefined)).not.toThrow();
  });

  it('unlocks after the lock period', () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    for (let i = 0; i < LoginThrottleService.MAX_PER_USER; i++) {
      service.recordFailure('admin', undefined);
    }
    expect(() => service.assertAllowed('admin', undefined)).toThrow(HttpException);
    spy.mockReturnValue(now + LoginThrottleService.LOCK_MS + 1);
    expect(() => service.assertAllowed('admin', undefined)).not.toThrow();
    spy.mockRestore();
  });
});

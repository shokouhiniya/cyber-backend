import { BadGatewayException, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { AllExceptionsFilter, INTERNAL_ERROR_MESSAGE } from './all-exceptions.filter';

const makeHost = () => {
  const res: any = { headersSent: false };
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  const req = { method: 'GET', originalUrl: '/api/stats' };
  const host: any = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  };
  return { host, res };
};

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('passes through 4xx messages in the standard envelope', () => {
    const { host, res } = makeHost();
    filter.catch(new NotFoundException('پروفایل یافت نشد'), host);
    expect(res.status).toHaveBeenCalledWith(404);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toEqual({ message: 'پروفایل یافت نشد', statusCode: 404 });
    expect(body.meta.status).toBe(404);
  });

  it('keeps validation message arrays', () => {
    const { host, res } = makeHost();
    filter.catch(new BadRequestException(['limit must be a number']), host);
    expect(res.json.mock.calls[0][0].error.message).toEqual(['limit must be a number']);
  });

  it('never leaks query text, parameters or stack for unknown errors', () => {
    const { host, res } = makeHost();
    const err: any = new Error('invalid input syntax for type uuid: "abc"');
    err.query = 'SELECT * FROM selected_posts WHERE profile_id = $1';
    err.parameters = ['abc'];
    filter.catch(err, host);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toEqual({ message: INTERNAL_ERROR_MESSAGE, statusCode: 500 });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('selected_posts');
    expect(serialized).not.toContain('uuid');
    expect(serialized).not.toContain('stack');
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('query=SELECT'), expect.any(String));
  });

  it('keeps the message of a deliberate 502', () => {
    const { host, res } = makeHost();
    filter.catch(new BadGatewayException('تحلیل سناریو با خطا مواجه شد'), host);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json.mock.calls[0][0].error.message).toBe('تحلیل سناریو با خطا مواجه شد');
  });

  it('does nothing when headers were already sent', () => {
    const { host, res } = makeHost();
    res.headersSent = true;
    filter.catch(new Error('late'), host);
    expect(res.json).not.toHaveBeenCalled();
  });
});

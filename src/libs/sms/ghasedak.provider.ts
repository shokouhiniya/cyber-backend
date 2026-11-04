import axios from 'axios';

import { maskPhone } from './phone';

/** Minimal HTTP surface the provider needs — lets tests inject a mock. */
export interface SmsHttpClient {
  post(
    url: string,
    body: URLSearchParams,
  ): Promise<{ status: number; data: any }>;
}

export interface GhasedakOptions {
  apiKey: string;
  baseUrl?: string;
  otpTemplate?: string;
  lineNumber?: string;
  timeoutMs?: number;
}

export interface SmsSendResult {
  ok: boolean;
  /** Ghasedak's message id(s) when it returns them. */
  messageId?: string | null;
  /** Safe-to-log reason; never contains the API key. */
  error?: string;
}

export const GHASEDAK_DEFAULT_BASE_URL = 'https://api.ghasedak.me';
export const GHASEDAK_DEFAULT_TIMEOUT_MS = 8000;

/**
 * Ghasedak (قاصدک) SMS gateway, v2 form-encoded API.
 *
 * - OTP: template endpoint `v2/verification/send/simple` (receptor, type=1,
 *   template, param1). The template text lives in the Ghasedak panel.
 * - Free text: `v2/sms/send/simple` (receptor, message, optional linenumber).
 *
 * The API key travels only in the `apikey` header of the HTTP client and is
 * never included in a returned error or log line.
 */
export class GhasedakProvider {
  private readonly http: SmsHttpClient;

  constructor(
    private readonly options: GhasedakOptions,
    http?: SmsHttpClient,
  ) {
    this.http =
      http ??
      axios.create({
        baseURL: options.baseUrl || GHASEDAK_DEFAULT_BASE_URL,
        timeout: options.timeoutMs || GHASEDAK_DEFAULT_TIMEOUT_MS,
        headers: {
          apikey: options.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
  }

  async sendOtp(phone: string, code: string): Promise<SmsSendResult> {
    if (!this.options.otpTemplate) {
      return { ok: false, error: 'GHASEDAK_OTP_TEMPLATE is not set' };
    }
    const body = new URLSearchParams();
    body.append('receptor', phone);
    body.append('type', '1');
    body.append('template', this.options.otpTemplate);
    body.append('param1', code);
    return this.post('v2/verification/send/simple', body, phone);
  }

  async sendText(phone: string, message: string): Promise<SmsSendResult> {
    const body = new URLSearchParams();
    body.append('receptor', phone);
    body.append('message', message);
    if (this.options.lineNumber) body.append('linenumber', this.options.lineNumber);
    return this.post('v2/sms/send/simple', body, phone);
  }

  private async post(endpoint: string, body: URLSearchParams, phone: string): Promise<SmsSendResult> {
    try {
      const res = await this.http.post(endpoint, body);
      const code = Number(res?.data?.result?.code ?? res?.status);
      if (res.status >= 200 && res.status < 300 && (!code || code === 200)) {
        const items = res?.data?.items;
        const messageId = Array.isArray(items) ? items.join(',') : items != null ? String(items) : null;
        return { ok: true, messageId };
      }
      return { ok: false, error: describe(res?.status, res?.data, phone) };
    } catch (err: any) {
      if (err?.response) {
        return { ok: false, error: describe(err.response.status, err.response.data, phone) };
      }
      // Network error / timeout: axios' message doesn't include headers
      const reason = err?.code === 'ECONNABORTED' ? 'timeout' : String(err?.message || 'network error');
      return { ok: false, error: `Ghasedak request to ${maskPhone(phone)} failed: ${reason.slice(0, 200)}` };
    }
  }
}

function describe(status: number | undefined, data: any, phone: string): string {
  const msg = data?.result?.message ?? data?.message ?? '';
  const code = data?.result?.code ?? '';
  return `Ghasedak rejected SMS to ${maskPhone(phone)}: HTTP ${status ?? '?'}${code ? ` code ${code}` : ''}${
    msg ? ` — ${String(msg).slice(0, 200)}` : ''
  }`;
}

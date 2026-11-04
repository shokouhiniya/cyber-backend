import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface BaleHttpClient {
  post(url: string, body: any, opts?: { timeout?: number }): Promise<{ status: number; data: any }>;
}

export const BALE_HTTP_CLIENT = Symbol('BALE_HTTP_CLIENT');
export const BALE_DEFAULT_BASE_URL = 'https://tapi.bale.ai';
const TIMEOUT_MS = 8000;

export interface BaleResult {
  ok: boolean;
  sent: number;
  failed: number;
  errors: string[];
}

/**
 * Bale bot messages: POST {base}/bot<token>/sendMessage {chat_id, text}.
 * Disabled (no network call at all) unless BALE_BOT_TOKEN is set. The token
 * is part of the URL, so errors are rebuilt from status + description only.
 */
@Injectable()
export class BaleClient {
  private readonly logger = new Logger(BaleClient.name);
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly http: BaleHttpClient;

  constructor(config: ConfigService, @Optional() @Inject(BALE_HTTP_CLIENT) http?: BaleHttpClient) {
    this.token = (config.get<string>('BALE_BOT_TOKEN') || '').trim();
    this.baseUrl = ((config.get<string>('BALE_API_BASE_URL') || '').trim() || BALE_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.http = http ?? axios;
  }

  get enabled(): boolean {
    return !!this.token;
  }

  async send(chatIds: string[], text: string): Promise<BaleResult> {
    const out: BaleResult = { ok: false, sent: 0, failed: 0, errors: [] };
    const targets = Array.from(new Set((chatIds || []).map((c) => String(c).trim()).filter(Boolean)));
    if (!targets.length) {
      out.errors.push('no Bale chat id');
      return out;
    }
    if (!this.enabled) {
      out.failed = targets.length;
      out.errors.push('BALE_BOT_TOKEN is not set');
      return out;
    }
    for (const chatId of targets) {
      const chat_id = /^-?\d+$/.test(chatId) ? Number(chatId) : chatId;
      try {
        const res = await this.http.post(
          `${this.baseUrl}/bot${this.token}/sendMessage`,
          { chat_id, text: text.slice(0, 4000) },
          { timeout: TIMEOUT_MS },
        );
        if (res.status >= 200 && res.status < 300 && res.data?.ok !== false) out.sent++;
        else this.fail(out, chatId, res.status, res.data?.description);
      } catch (err: any) {
        if (err?.response) this.fail(out, chatId, err.response.status, err.response.data?.description);
        else this.fail(out, chatId, undefined, err?.code === 'ECONNABORTED' ? 'timeout' : 'network error');
      }
    }
    out.ok = out.sent > 0 && out.failed === 0;
    return out;
  }

  private fail(out: BaleResult, chatId: string, status: number | undefined, description?: string) {
    out.failed++;
    const msg = `Bale sendMessage to chat ${chatId} failed: ${status ? `HTTP ${status}` : ''}${
      description ? ` ${String(description).slice(0, 200)}` : ''
    }`.trim();
    out.errors.push(msg);
    this.logger.error(msg);
  }
}

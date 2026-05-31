import { Injectable, Logger, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ----------------------------------------------------------------------

export interface PromticInvokeOptions {
  promptName: string;
  inputVars?: Record<string, any>;
  identifier?: {
    external_id: string;
    name?: string;
    type?: string;
  };
  modelName?: string;
  params?: {
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    response_format?: { type: 'json_object' | 'text' };
  };
  webhookUrl?: string;
  webhookCustomHeaders?: Record<string, string>;
  metaData?: Record<string, any>;
  traceId?: string;
  promptVersionId?: string;
}

export interface PromticResult {
  uid: string;
  prompt_name: string;
  status: 'completed' | 'pending' | 'processing' | 'error' | 'timeout';
  result?: string;
  error_message?: string;
  model_name?: string;
  latency_ms?: number;
  token_usage?: {
    prompt: number;
    completion: number;
    total: number;
  };
  cost_usd?: number;
  created_at?: string;
}

// ----------------------------------------------------------------------

@Injectable()
export class PromticService {
  private readonly logger = new Logger(PromticService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxPollAttempts = 60;
  private readonly pollIntervalMs = 2000;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('PROMTIC_BASE_URL', 'https://papi.korsi.ai');
    this.apiKey = this.configService.get<string>('PROMTIC_API_KEY', '');

    if (!this.apiKey) {
      this.logger.warn('PROMTIC_API_KEY is not set. LLM calls will fail.');
    }
  }

  /**
   * Execute a prompt and return the result.
   * Handles both immediate completion and polling for long-running tasks.
   */
  async invoke(options: PromticInvokeOptions): Promise<string> {
    const meta = await this.invokeWithMeta(options);
    return meta.result;
  }

  /**
   * Like invoke() but also returns metadata (uid, prompt_name, model, latency, token_usage).
   */
  async invokeWithMeta(options: PromticInvokeOptions): Promise<{ result: string; uid?: string; promptName?: string; modelName?: string; latencyMs?: number; tokenUsage?: any }> {
    const invocation = await this.execute(options);

    let finalResult: PromticResult = invocation;

    if (invocation.status !== 'completed') {
      if (invocation.status === 'error') {
        throw new HttpException(
          `Promtic invocation failed: ${invocation.error_message || 'Unknown error'}`,
          500,
        );
      }
      // Poll
      const polled = await this.pollFull(invocation.uid);
      finalResult = polled;
    }

    return {
      result: finalResult.result || '',
      uid: finalResult.uid,
      promptName: finalResult.prompt_name,
      modelName: finalResult.model_name,
      latencyMs: finalResult.latency_ms,
      tokenUsage: finalResult.token_usage,
    };
  }

  /**
   * Execute a prompt (POST /invocations/execute).
   * Returns the raw invocation result (may be pending).
   */
  async execute(options: PromticInvokeOptions): Promise<PromticResult> {
    const body: Record<string, any> = {
      prompt_name: options.promptName,
    };

    if (options.inputVars) body.input_vars = options.inputVars;
    if (options.identifier) body.identifier = options.identifier;
    if (options.modelName) body.model_name = options.modelName;
    if (options.params) body.params = options.params;
    if (options.webhookUrl) body.webhook_url = options.webhookUrl;
    if (options.webhookCustomHeaders) body.webhook_custom_headers = options.webhookCustomHeaders;
    if (options.metaData) body.meta_data = options.metaData;
    if (options.traceId) body.trace_id = options.traceId;
    if (options.promptVersionId) body.prompt_version_id = options.promptVersionId;

    const response = await this.request('POST', '/invocations/execute', body);
    return response.data;
  }

  /**
   * Poll for invocation result (GET /invocations/:uid).
   * Retries up to maxPollAttempts with pollIntervalMs delay.
   */
  async poll(uid: string): Promise<string> {
    let attempts = 0;

    while (attempts < this.maxPollAttempts) {
      await this.sleep(this.pollIntervalMs);

      const response = await this.request('GET', `/invocations/${uid}`);
      const result: PromticResult = response.data;

      if (result.status === 'completed') {
        return result.result || '';
      }

      if (result.status === 'error') {
        throw new HttpException(
          `Promtic invocation failed: ${result.error_message || 'Unknown error'}`,
          500,
        );
      }

      if (result.status === 'timeout') {
        throw new HttpException('Promtic invocation timed out', 504);
      }

      attempts++;
    }

    throw new HttpException('Promtic polling timeout: max attempts reached', 504);
  }

  /**
   * Like poll() but returns the full PromticResult instead of just the string.
   */
  async pollFull(uid: string): Promise<PromticResult> {
    let attempts = 0;

    while (attempts < this.maxPollAttempts) {
      await this.sleep(this.pollIntervalMs);

      const response = await this.request('GET', `/invocations/${uid}`);
      const result: PromticResult = response.data;

      if (result.status === 'completed') return result;

      if (result.status === 'error') {
        throw new HttpException(
          `Promtic invocation failed: ${result.error_message || 'Unknown error'}`,
          500,
        );
      }

      if (result.status === 'timeout') {
        throw new HttpException('Promtic invocation timed out', 504);
      }

      attempts++;
    }

    throw new HttpException('Promtic polling timeout: max attempts reached', 504);
  }

  /**
   * Get invocation status by UID.
   */
  async getInvocation(uid: string): Promise<PromticResult> {
    const response = await this.request('GET', `/invocations/${uid}`);
    return response.data;
  }

  /**
   * List invocations with optional filters.
   */
  async listInvocations(filters?: {
    offset?: number;
    limit?: number;
    prompt_name?: string;
    api_client_id?: number;
    identifier_id?: number;
  }): Promise<any> {
    const params = new URLSearchParams();
    if (filters?.offset !== undefined) params.set('offset', String(filters.offset));
    if (filters?.limit !== undefined) params.set('limit', String(filters.limit));
    if (filters?.prompt_name) params.set('prompt_name', filters.prompt_name);
    if (filters?.api_client_id) params.set('api_client_id', String(filters.api_client_id));
    if (filters?.identifier_id) params.set('identifier_id', String(filters.identifier_id));

    const query = params.toString();
    const path = query ? `/invocations?${query}` : '/invocations';
    return this.request('GET', path);
  }

  // --- Private helpers ---

  private async request(method: 'GET' | 'POST', path: string, body?: any): Promise<any> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json',
    };

    const fetchOptions: RequestInit = { method, headers };
    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    // Retry up to 3 times on network errors (DNS flakiness, connection reset)
    const MAX_RETRIES = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, fetchOptions);
        const responseText = await response.text();
      if (!response.ok) {
        this.logger.error(`Promtic ${method} ${path} failed: ${response.status} - ${responseText}`);

        switch (response.status) {
          case 400:
            throw new HttpException(`Promtic: Bad request - ${responseText}`, 400);
          case 401:
            throw new HttpException('Promtic: Invalid or inactive API key', 401);
          case 404:
            throw new HttpException('Promtic: Prompt or invocation not found', 404);
          default:
            throw new HttpException(`Promtic: Server error (${response.status}) - ${responseText}`, 500);
        }
      }

      let parsed: any;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        throw new HttpException(`Promtic: Invalid JSON response - ${responseText.slice(0, 200)}`, 500);
      }

      // Handle both { data: ... } and flat response shapes
      if (parsed && typeof parsed === 'object') {
        this.logger.debug(`Promtic response keys: ${Object.keys(parsed).join(', ')}`);
        if ('data' in parsed) return parsed;
        // Flat response — wrap it
        return { data: parsed };
      }

      return { data: parsed };
      } catch (error) {
        if (error instanceof HttpException) throw error;
        lastError = error as Error;
        this.logger.warn(`Promtic request attempt ${attempt}/${MAX_RETRIES} failed: ${(error as Error).message}`);
        if (attempt < MAX_RETRIES) {
          await this.sleep(1000 * attempt); // 1s, 2s backoff
        }
      }
    }

    this.logger.error(`Promtic request failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
    throw new HttpException(`Promtic: Network error - ${lastError?.message}`, 503);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

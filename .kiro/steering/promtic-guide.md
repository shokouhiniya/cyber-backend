# Promtic LLM Gateway — Development Guide

## Overview

All LLM calls in this project route through **Promtic** (https://papi.korsi.ai), a centralized prompt management gateway. We do NOT use direct OpenAI/Anthropic SDK calls.

## Architecture

```
Service → PromticService.invoke() → POST papi.korsi.ai/invocations/execute → LLM → Result
```

- **PromticService** is a global NestJS service at `src/libs/promtic/promtic.service.ts`
- It's registered globally via `PromticModule` — inject it anywhere without importing the module
- API key is stored in `.env` as `PROMTIC_API_KEY` (never expose to frontend)

## How to Use

### 1. Inject the service

```typescript
import { PromticService } from 'src/libs/promtic';

@Injectable()
export class MyService {
  constructor(private readonly promtic: PromticService) {}
}
```

### 2. Call a prompt

```typescript
const result = await this.promtic.invoke({
  promptName: 'my_prompt_name',       // Must exist in Promtic panel
  inputVars: { text: '...', lang: 'fa' }, // Maps to {{text}}, {{lang}} in prompt
  identifier: {
    external_id: 'org-123',           // Required for cost tracking per tenant
    name: 'Client Name',
    type: 'organization',
  },
  params: { temperature: 0.7, max_tokens: 2000 }, // Optional overrides
});
// result is a string — the LLM output
```

### 3. The service handles:
- Immediate responses (status: completed)
- Polling for long-running tasks (auto-polls every 2s, max 60 attempts)
- Error handling (400/401/404/500 mapped to NestJS HttpExceptions)
- Timeout detection

## Prompt Management

Prompts are defined in the **Promtic panel** (not in code). To add a new LLM feature:

1. Create the prompt in the Promtic panel with a unique `prompt_name`
2. Define input variables using `{{variable_name}}` syntax
3. Set a default model and parameters
4. Call `this.promtic.invoke({ promptName: 'your_prompt_name', inputVars: {...} })` from your service

## Environment Variables

```env
PROMTIC_BASE_URL=https://papi.cyber.pish.run
PROMTIC_API_KEY=your_key_here
```

## Important Rules

- **NEVER** expose `PROMTIC_API_KEY` in frontend code
- **ALWAYS** pass `identifier.external_id` for cost tracking
- **NEVER** make direct OpenAI/Anthropic/etc SDK calls — use PromticService
- Prompts are versioned in the panel — use `promptVersionId` only if you need to pin a specific version
- For async/webhook patterns, pass `webhookUrl` in the options

## File Locations

- Service: `src/libs/promtic/promtic.service.ts`
- Module: `src/libs/promtic/promtic.module.ts`
- Exports: `src/libs/promtic/index.ts`
- Registered in: `src/app.module.ts`

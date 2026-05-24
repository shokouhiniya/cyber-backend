import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';
import { isNonPersianText, isGarbledSttText } from '../../libs/text-utils/language-detect';

// ----------------------------------------------------------------------

interface TokenCache {
  token: string;
  expiresAt: number; // unix ms
}

// ----------------------------------------------------------------------

@Injectable()
export class DataSourceApiService {
  private readonly logger = new Logger(DataSourceApiService.name);

  /**
   * In-memory token cache keyed by username.
   * Tokens are reused until 1 hour before expiry, then refreshed automatically.
   * This avoids a login round-trip on every ingestion call while never
   * requiring manual token rotation in .env.
   *
   * Security note: credentials (username + password) stay in the DB's
   * credentials jsonb column. The token is derived from them at runtime
   * and lives only in process memory — it is never persisted to disk or .env.
   */
  private readonly tokenCache = new Map<string, TokenCache>();

  // ------------------------------------------------------------------
  // Token management
  // ------------------------------------------------------------------

  private decodeJwtExp(token: string): number | null {
    try {
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64').toString(),
      );
      return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
    } catch {
      return null;
    }
  }

  /**
   * Returns a valid 8tag JWT for the given credentials.
   * Uses the in-memory cache; refreshes automatically when the token is
   * within 1 hour of expiry.
   */
  private async get8tagToken(credentials: {
    username: string;
    password: string;
  }): Promise<string> {
    const cacheKey = credentials.username;
    const cached = this.tokenCache.get(cacheKey);
    const refreshThresholdMs = 60 * 60 * 1000; // 1 hour before expiry

    if (cached && cached.expiresAt - Date.now() > refreshThresholdMs) {
      this.logger.debug(`8tag: reusing cached token for ${cacheKey}`);
      return cached.token;
    }

    this.logger.log(`8tag: acquiring fresh token for ${cacheKey}`);
    const domain = 'https://d1.8tag.ir';

    const loginResponse = await axios.post(
      `${domain}/api/v4/login`,
      { username: credentials.username, password: credentials.password },
      { headers: { 'Content-Type': 'application/json' } },
    );

    if (loginResponse.data.status !== 200) {
      throw new Error(
        `8tag login failed: ${loginResponse.data.error || 'Unknown error'}`,
      );
    }

    const token: string = loginResponse.data.result;
    const expiresAt = this.decodeJwtExp(token) ?? Date.now() + 6 * 24 * 60 * 60 * 1000; // default 6 days

    this.tokenCache.set(cacheKey, { token, expiresAt });
    this.logger.log(
      `8tag: token cached for ${cacheKey}, expires ${new Date(expiresAt).toISOString()}`,
    );

    return token;
  }

  // ------------------------------------------------------------------
  // Public API methods
  // ------------------------------------------------------------------

  /**
   * Searches 8tag using the /api/v4/search endpoint.
   *
   * params.source can be a single string OR an array of source strings.
   * When multiple sources are provided, requests run in parallel and results
   * are merged, sorted by publishedAt descending, and capped at params.size.
   *
   * Threshold filtering (optional):
   *   params.minViews      — minimum viewCount
   *   params.minLikes      — minimum likeCount
   *   params.minRetweets   — minimum retweetCount
   *   params.minReplies    — minimum replyCount
   *   params.minFollowers  — minimum userFollowers
   *   params.minQuotes     — minimum quoteCount (X only)
   *   params.minBookmarks  — minimum bookmarkCount (X only)
   *
   * When a threshold is set, the sort is automatically overridden to the
   * matching metric (e.g. minViews → sort=views) and pages are fetched
   * until the last item in a page falls below the threshold.
   * Max pages fetched: 10 (to avoid runaway API calls).
   */
  async search8tag(credentials: any, params: any): Promise<any> {
    // Normalise source to an array
    const sources: string[] = Array.isArray(params.source)
      ? params.source
      : [params.source || 'telegram'];

    if (sources.length === 1) {
      return this.search8tagSingle(credentials, { ...params, source: sources[0] });
    }

    // Multi-source: run in parallel, merge results
    const perSourceSize = Math.ceil((params.size || 100) / sources.length) * 2;
    const results = await Promise.allSettled(
      sources.map((src) =>
        this.search8tagSingle(credentials, { ...params, source: src, size: perSourceSize }),
      ),
    );

    const allItems: any[] = [];
    let totalSum = 0;
    const errors: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        allItems.push(...(r.value.data || []));
        totalSum += r.value.total || 0;
      } else {
        errors.push(`${sources[i]}: ${r.reason?.message || 'error'}`);
        this.logger.warn(`8tag multi-source: ${sources[i]} failed — ${r.reason?.message}`);
      }
    }

    // Sort merged results by publishedAt descending, cap at requested size
    allItems.sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    });

    const size = params.size || 100;
    const trimmed = allItems.slice(0, size);

    return {
      status: errors.length === sources.length ? 'error' : 'success',
      total: totalSum,
      count: trimmed.length,
      sources,
      errors: errors.length ? errors : undefined,
      filters: {
        or: params.or || null,
        and: params.and || null,
        not: params.not || null,
        range: params.range || 'week',
        sort: params.sort || 'recent',
      },
      data: trimmed,
    };
  }

  /**
   * Maps a threshold param name to the sort value and the mapped field name.
   */
  private thresholdToSort(params: any): { sort: string; field: string; min: number } | null {
    const checks: Array<{ param: string; sort: string; field: string }> = [
      { param: 'minViews',     sort: 'views',     field: 'viewCount' },
      { param: 'minLikes',     sort: 'likes',     field: 'likeCount' },
      { param: 'minRetweets',  sort: 'forwards',  field: 'retweetCount' },
      { param: 'minReplies',   sort: 'comments',  field: 'replyCount' },
      { param: 'minFollowers', sort: 'member',    field: 'userFollowers' },
      { param: 'minQuotes',    sort: 'forwards',  field: 'quoteCount' },
      { param: 'minBookmarks', sort: 'bookmarks', field: 'bookmarkCount' },
      { param: 'minEngagement',sort: 'engagement',field: 'viewCount' },
    ];
    for (const c of checks) {
      if (params[c.param] !== undefined && params[c.param] !== null && params[c.param] !== '') {
        const min = parseInt(String(params[c.param]), 10);
        if (!isNaN(min) && min > 0) return { sort: c.sort, field: c.field, min };
      }
    }
    return null;
  }

  /**
   * Single-source search — the actual 8tag API call.
   * Supports threshold-based pagination when minXxx params are provided.
   */
  private async search8tagSingle(credentials: any, params: any): Promise<any> {
    try {
      const domain = 'https://d1.8tag.ir';
      const token = await this.get8tagToken(credentials);

      // Detect threshold mode
      const threshold = this.thresholdToSort(params);
      const effectiveSort = threshold ? threshold.sort : (params.sort || 'recent');
      const pageSize = 100; // always fetch max per page in threshold mode
      const maxPages = 10;

      const basePayload: Record<string, any> = {
        token,
        source:   params.source   || 'telegram',
        sort:     effectiveSort,
        range:    params.range    || 'week',
        size:     threshold ? pageSize : (params.size || 100),
        lang:     params.lang     || 'fa',
        retweet:  params.retweet  ?? 'false',
        forward:  params.forward  ?? 'false',
        reply:    params.reply    ?? 'true',
        quote:    params.quote    ?? 'true',
      };

      if (params.or)         basePayload.or         = params.or;
      if (params.and)        basePayload.and        = params.and;
      if (params.not)        basePayload.not        = params.not;
      if (params.publishers) basePayload.publishers = params.publishers;

      if (params.range === 'custom') {
        if (params.since) basePayload.since = params.since;
        if (params.max)   basePayload.max   = params.max;
      }

      if (!threshold) {
        // Simple single-page fetch
        this.logger.log(`8tag search: source=${basePayload.source} range=${basePayload.range} size=${basePayload.size}`);
        const response = await axios.post(`${domain}/api/v4/search`, basePayload, { headers: { 'Content-Type': 'application/json' } });
        const { total, result: items = [] } = response.data;
        this.logger.log(`8tag search returned ${items.length} of ${total} total results`);
        let mapped = items
          .map((item: any) => this.mapSearchResult(item, basePayload.source))
          .filter(Boolean); // mapSearchResult returns null for low-quality newspaper segments

        // Deduplicate by id — 8tag sometimes returns the same post cached at different
        // times with different view counts. Keep the snapshot with the highest viewCount.
        const seen = new Map<string, any>();
        for (const item of mapped) {
          const existing = seen.get(item.id);
          if (!existing || (item.viewCount || 0) > (existing.viewCount || 0)) {
            seen.set(item.id, item);
          }
        }
        mapped = Array.from(seen.values());

        // Client-side language filter: the 8tag API ignores lang= for telegram/messaging.
        // We filter Arabic-only posts when lang=fa is requested (use basePayload.lang, not params.lang,
        // since params.lang may be undefined when the frontend omits it for Twitter).
        if (basePayload.lang === 'fa') {
          const before = mapped.length;
          mapped = mapped.filter((item: any) => !isNonPersianText(item.text));
          if (mapped.length < before) {
            this.logger.log(`8tag lang=fa filter: removed ${before - mapped.length} non-Persian (Arabic/Urdu) posts`);
          }
        }

        // Hashtag spam filter: drop posts that have more hashtags than the threshold.
        // Counts both the structured hashtags array AND inline #tags in the text body.
        const maxHashtags = params.maxHashtags != null ? parseInt(String(params.maxHashtags), 10) : null;
        if (maxHashtags != null && !isNaN(maxHashtags)) {
          const before = mapped.length;
          mapped = mapped.filter((item: any) => {
            const structuredCount = Array.isArray(item.hashtags) ? item.hashtags.length : 0;
            const inlineCount = (item.text?.match(/#[\u0600-\u06FF\w]+/g) || []).length;
            return Math.max(structuredCount, inlineCount) <= maxHashtags;
          });
          if (mapped.length < before) {
            this.logger.log(`8tag hashtag filter (max=${maxHashtags}): removed ${before - mapped.length} spammy posts`);
          }
        }

        // Garbled STT filter: drop media/TV posts with low-quality speech-to-text transcripts.
        // Only applied to the 'media' source — other sources don't have STT text.
        if (basePayload.source === 'media') {
          const before = mapped.length;
          mapped = mapped.filter((item: any) => !isGarbledSttText(item.text));
          if (mapped.length < before) {
            this.logger.log(`8tag STT filter: removed ${before - mapped.length} garbled media transcripts`);
          }
        }

        return { status: 'success', total, count: mapped.length, source: basePayload.source, filters: { or: params.or || null, and: params.and || null, not: params.not || null, range: basePayload.range, sort: basePayload.sort, lang: basePayload.lang }, data: mapped };
      }

      // Threshold mode: paginate until last item falls below threshold
      this.logger.log(`8tag threshold search: source=${basePayload.source} ${threshold.field}>=${threshold.min} sort=${effectiveSort}`);

      const collected: any[] = [];
      let totalFromApi = 0;
      let page = 0;
      let lastTimestamp: number | null = null;

      while (page < maxPages) {
        const payload = { ...basePayload };

        // Use since/max for pagination: after first page, set max to the timestamp of the last item
        if (page > 0 && lastTimestamp !== null) {
          payload.range = 'custom';
          payload.max = lastTimestamp - 1; // exclusive
          payload.since = 0;
        }

        const response = await axios.post(`${domain}/api/v4/search`, payload, { headers: { 'Content-Type': 'application/json' } });
        const { total, result: items = [] } = response.data;
        if (page === 0) totalFromApi = total;

        if (!items.length) break;

        const mapped = items
          .map((item: any) => this.mapSearchResult(item, basePayload.source))
          .filter(Boolean); // null = low-quality newspaper segment

        // Filter items meeting the threshold
        let hitFloor = false;
        for (const item of mapped) {
          // Apply language filter client-side (API ignores lang= for messaging sources)
          if (basePayload.lang === 'fa' && isNonPersianText(item.text)) continue;

          // Hashtag spam filter
          const maxHashtags = params.maxHashtags != null ? parseInt(String(params.maxHashtags), 10) : null;
          if (maxHashtags != null && !isNaN(maxHashtags)) {
            const structuredCount = Array.isArray(item.hashtags) ? item.hashtags.length : 0;
            const inlineCount = (item.text?.match(/#[\u0600-\u06FF\w]+/g) || []).length;
            if (Math.max(structuredCount, inlineCount) > maxHashtags) continue;
          }

          // Garbled STT filter for media source
          if (basePayload.source === 'media' && isGarbledSttText(item.text)) continue;

          const val = item[threshold.field] || 0;
          if (val >= threshold.min) {
            collected.push(item);
          } else {
            hitFloor = true;
            break;
          }
        }

        // Track last timestamp for next page
        const lastItem = items[items.length - 1];
        lastTimestamp = lastItem?.timestamp || null;

        this.logger.log(`8tag threshold page ${page + 1}: got ${items.length}, kept ${collected.length} (threshold ${threshold.field}>=${threshold.min})`);

        if (hitFloor || items.length < pageSize || !lastTimestamp) break;
        page++;
      }

      return {
        status: 'success',
        total: totalFromApi,
        count: collected.length,
        source: basePayload.source,
        thresholdApplied: { field: threshold.field, min: threshold.min, sort: effectiveSort },
        filters: { or: params.or || null, and: params.and || null, not: params.not || null, range: params.range || 'week', sort: effectiveSort },
        data: collected,
      };
    } catch (error) {
      this.logger.error(`8tag search error: ${error.message}`, error.stack);
      if (error.response) {
        const { status, data } = error.response;
        const msg = data?.error || error.message;
        switch (status) {
          case 400: throw new HttpException(`8tag: Bad request — ${msg}`, HttpStatus.BAD_REQUEST);
          case 403: throw new HttpException(`8tag: ${msg}`, HttpStatus.FORBIDDEN);
          case 416: throw new HttpException(`8tag: Data range not accessible — ${msg}`, HttpStatus.BAD_REQUEST);
          case 429: throw new HttpException(`8tag: Rate limit reached — ${msg}`, HttpStatus.TOO_MANY_REQUESTS);
          default:  throw new HttpException(`8tag: ${msg}`, HttpStatus.BAD_REQUEST);
        }
      }
      throw new HttpException(`8tag search error: ${error.message}`, HttpStatus.BAD_REQUEST);
    }
  }

  /**
   * Derives a sentiment label from 8tag's numeric sentiment field.
   * -1 = negative, 0 = neutral, 1 = positive
   */
  private numericSentimentToLabel(val: number | null | undefined): string {
    if (val === 1)  return 'positive';
    if (val === -1) return 'negative';
    return 'neutral';
  }

  /**
   * Derives a rough sentiment from Telegram emoji reactions.
   * Positive emojis: 👍 ❤ 🥰 👏 🔥 ⭐ 😍 🎉 🙏 💯
   * Negative emojis: 👎 🤬 😡 💩 🖕 🤮 😢 😭
   * Returns 'positive', 'negative', or 'neutral'.
   */
  private sentimentFromReactions(reactions: Array<{ reaction: string; count: number }> | null): string {
    if (!reactions || reactions.length === 0) return 'neutral';

    const POSITIVE = new Set(['👍','❤','🥰','👏','🔥','⭐','😍','🎉','🙏','💯','😁','🤩','💪','✅','🌹']);
    const NEGATIVE = new Set(['👎','🤬','😡','💩','🖕','🤮','😢','😭','🤦','🤷','😤','🤯','🥴']);

    let pos = 0, neg = 0;
    for (const r of reactions) {
      if (POSITIVE.has(r.reaction)) pos += r.count;
      else if (NEGATIVE.has(r.reaction)) neg += r.count;
    }

    const total = pos + neg;
    if (total === 0) return 'neutral';
    const ratio = pos / total;
    if (ratio > 0.6) return 'positive';
    if (ratio < 0.4) return 'negative';
    return 'neutral';
  }

  /**
   * Maps a raw 8tag search result to our Content entity shape.
   * Handles the different field shapes across source types.
   */
  private mapSearchResult(item: any, source: string): Record<string, any> | null {
    // --- Telegram / Bale / Rubika / Eitaa (messaging platforms) ---
    if (['telegram', 'bale', 'rubika', 'eitaa'].includes(source)) {
      const reactions = Array.isArray(item.obj_reactions) ? item.obj_reactions : null;

      // Rubika and Bale have a numeric sentiment field; Telegram/Eitaa don't.
      // Fall back to emoji-reaction inference for Telegram.
      let sentiment: string;
      if (item.sentiment !== null && item.sentiment !== undefined) {
        sentiment = this.numericSentimentToLabel(item.sentiment);
      } else if (source === 'telegram') {
        sentiment = this.sentimentFromReactions(reactions);
      } else {
        sentiment = 'neutral';
      }

      // Telegram doesn't serve media URLs — flag the type so the UI can show an icon
      const hasMedia = item.type === 'photo' || item.type === 'video';

      // Bale has reactions but the official 8tag UI doesn't show them — we keep them
      // since they're useful data. Set to null for Eitaa (no reactions field).
      const displayReactions = ['telegram', 'bale', 'rubika'].includes(source) ? reactions : null;

      // Rubika uses item.channel.*, Bale uses item.peer.*, Telegram/Eitaa use item.peer_* flat fields.
      let screenName: string | null;
      let displayName: string | null;
      let userFollowers: number;
      let profileImageUrl: string | null;
      let userId: string | null;

      if (source === 'rubika') {
        screenName      = item.channel?.username || item.channel?.title || null;
        displayName     = item.channel?.title || null;
        userFollowers   = item.channel?.participants || 0;
        profileImageUrl = item.channel?.profile || null;
        userId          = item.channel?.username || null;
      } else if (source === 'bale') {
        screenName      = item.peer?.username || item.peer?.title || null;
        displayName     = item.peer?.title || null;
        userFollowers   = item.peer?.participants || 0;
        profileImageUrl = item.peer?.avatar || null;
        userId          = item.peer?.username || null;
      } else {
        // Telegram / Eitaa — flat peer_* fields
        screenName      = item.peer_username || item.peer_title || null;
        displayName     = null;
        userFollowers   = item.peer_participants_count || 0;
        profileImageUrl = null;
        userId          = item.peer_username || null;
      }

      // Use numeric item.id as the stable unique identifier.
      // record_index is a URL that may differ across cached snapshots of the same post.
      const stableId = item.id ? String(item.id) : (item.record_index || String(Math.random()));

      return {
        id: stableId,
        text: item.text || '',
        sourceType: source,
        screenName,
        displayName,
        userId,
        userFollowers,
        profileImageUrl,
        viewCount: item.views || item.impression || 0,
        likeCount: item.total_reactions || 0,
        retweetCount: item.forwards || 0,
        replyCount: item.comments_count || 0,
        quoteCount: 0,
        bookmarkCount: 0,
        hashtags: Array.isArray(item.hashtags) ? item.hashtags : [],
        publishedAt: item.timestamp
          ? new Date(item.timestamp * 1000).toISOString()
          : item.date ? new Date(item.date).toISOString() : null,
        postType: item.type || null,
        sentiment,
        reactions: displayReactions,
        hasMedia,
        postUrl: item.record_index || null,
        _raw: item,
      };
    }

    // --- Twitter / Forum (text-based social) ---
    if (['twitter', 'forum'].includes(source)) {
      const meta = item.meta_data || {};

      // Twitter has completely different field names from other sources
      if (source === 'twitter') {
        const postType = item.is_retweet_status ? 'retweet'
          : item.is_quote_status ? 'quote'
          : item.in_reply ? 'reply'
          : 'tweet';

        return {
          id: String(item.id),
          text: item.text || '',
          sourceType: source,
          // user_name is the @handle, user_screen_name is the display name
          screenName: item.user_name || item.user_screen_name || null,
          displayName: item.user_screen_name || null,
          userId: item.user_name || null,
          userFollowers: item.followers || 0,
          viewCount: item.views || item.impression || 0,
          likeCount: item.favorite_count || 0,
          retweetCount: item.retweet_count || 0,
          replyCount: item.reply_count || 0,
          quoteCount: item.quoted_count || 0,
          bookmarkCount: item.bookmarks || 0,
          hashtags: Array.isArray(item.hashtags) ? item.hashtags : [],
          publishedAt: item.timestamp
            ? new Date(item.timestamp * 1000).toISOString()
            : item.time ? new Date(item.time).toISOString() : null,
          postType,
          sentiment: 'neutral',
          hasImage: item.tweet_has_image || false,
          hasVideo: item.tweet_has_video || false,
          retweetUser: item.retweet_user_username || null,
          // Construct X post URL from user_name + id
          postUrl: item.user_name && item.id
            ? `https://x.com/${item.user_name}/status/${item.id}`
            : null,
          _raw: item,
        };
      }

      // Forum
      return {
        id: String(item.id),
        text: item.text || '',
        sourceType: source,
        screenName: item.user?.username || item.platform || null,
        userId: item.user?.id ? String(item.user.id) : null,
        userFollowers: item.user?.followers_count || 0,
        viewCount: meta.view_count || item.impression || 0,
        likeCount: meta.like_count || item.engagement?.like_count || 0,
        retweetCount: meta.repost_count || item.engagement?.retweet_count || 0,
        replyCount: meta.reply_count || item.engagement?.reply_count || 0,
        quoteCount: 0,
        bookmarkCount: 0,
        hashtags: Array.isArray(item.text_hashtags) ? item.text_hashtags : [],
        publishedAt: item.timestamp
          ? new Date(item.timestamp * 1000).toISOString()
          : item.created_at ? new Date(item.created_at * 1000).toISOString() : null,
        postType: item.retweeted_id ? 'retweet' : item.replied_id ? 'reply' : 'post',
        sentiment: this.numericSentimentToLabel(item.sentiment),
        mediaUrl: item.link || null,
        postUrl: item.link || null,
        _raw: item,
      };
    }

    // --- Instagram ---
    if (source === 'instagram') {
      // Instagram uses different field names: likesCount, commentsCount, username, follower_count
      // publisher_url is the profile picture CDN URL (t51.82787-19 path = profile photo)
      return {
        id: String(item.postId || item.id),
        text: item.caption || item.text || '',
        sourceType: source,
        screenName: item.username || item.owner?.username || null,
        displayName: item.full_name || null,
        userId: item.userId ? String(item.userId) : null,
        userFollowers: item.follower_count || item.owner?.followers_count || 0,
        profileImageUrl: item.publisher_url || null,
        viewCount: item.viewCount || item.view_count || item.video_view_count || 0,
        likeCount: item.likesCount || item.like_count || 0,
        retweetCount: 0,   // Instagram has no repost field in the API
        replyCount: item.commentsCount || item.comment_count || 0,
        quoteCount: 0,
        bookmarkCount: 0,
        hashtags: Array.isArray(item.hashtags) ? item.hashtags : [],
        publishedAt: item.timestamp
          ? new Date(item.timestamp * 1000).toISOString()
          : item.timeOfset ? new Date(item.timeOfset * 1000).toISOString()
          : item.postCreatedAt ? new Date(item.postCreatedAt).toISOString() : null,
        postType: item.postType || item.media_type || null,
        sentiment: this.numericSentimentToLabel(item.sentiment),
        // Use first video/image from videos array, or imgSrc
        mediaUrl: (Array.isArray(item.videos) && item.videos[0]?.url) || item.imgSrc || null,
        postUrl: item.url || (item.postCode ? `https://instagram.com/p/${item.postCode}` : null),
        _raw: item,
      };
    }

    // --- News (online news sites) ---
    if (source === 'news') {
      const publisherName = typeof item.publisher === 'string'
        ? item.publisher
        : item.publisher?.title || item.publisher?.domain || null;
      const publisherRank = item.publisher?.rank ?? null;

      // abstract is often null; text is the full article body
      const abstract = item.abstract && item.abstract.trim().length >= 15
        ? item.abstract.trim()
        : null;
      const fullBody = item.text || null;

      return {
        id: item.url
          ? `news-${item.timestamp}-${item.url.slice(-20)}`
          : `news-${item.timestamp}-${Math.random()}`,
        text: abstract || fullBody || item.title || '',
        title: item.title || null,
        fullText: fullBody && abstract && fullBody !== abstract ? fullBody : null,
        sourceType: source,
        screenName: publisherName,
        userId: null,
        userFollowers: 0,
        publisherRank,
        viewCount: item.views || item.impression || 0,
        likeCount: item.likes || 0,
        retweetCount: item.copy_count || 0,
        replyCount: item.comments || 0,
        quoteCount: 0,
        bookmarkCount: 0,
        hashtags: Array.isArray(item.tags) ? item.tags
          : Array.isArray(item.text_tags) ? item.text_tags : [],
        publishedAt: item.timestamp
          ? new Date(item.timestamp * 1000).toISOString()
          : item.created_at ? new Date(item.created_at * 1000).toISOString() : null,
        postType: 'article',
        sentiment: this.numericSentimentToLabel(item.sentiment),
        mediaUrl: item.image || (Array.isArray(item.images) ? item.images[0] : null) || null,
        articleUrl: item.url || null,
        postUrl: item.url || null,
        topic: item.topic || null,
        locationTags: item.location_tags || null,
        _raw: item,
      };
    }

    // --- Newspaper (OCR'd print newspaper scans) ---
    if (source === 'newspaper') {
      // Newspaper items are OCR segments from scanned pages.
      // They have no URL, no publisher object — just name_fa, ocr text, page info.
      const s3Base = item.s3_endpoint
        ? `https://${item.s3_endpoint}/hashtag/`
        : 'https://s3.adcore.ir/hashtag/';

      // Best available image: segment crop > page thumbnail > half-page cover
      const segmentImg = item.s3_segment_fullpath
        ? `${s3Base}${item.s3_segment_fullpath}`
        : null;
      const pageThumb = item.page_thumb_path
        ? `${s3Base}${item.page_thumb_path}`
        : null;
      const coverImg = item.original_pdf_half_page
        ? `${s3Base}${item.original_pdf_half_page}`
        : null;

      // 8tag's own `selected_text` field tells us which version it considers best.
      // Honour that choice, then fall back through the candidates.
      const selectedField = item.selected_text as string | undefined;
      const candidates: string[] = [];
      if (selectedField && item[selectedField]) candidates.push(item[selectedField]);
      if (item.pdf_to_text_result_clean) candidates.push(item.pdf_to_text_result_clean);
      if (item.ocr_result_clean)         candidates.push(item.ocr_result_clean);
      if (item.text)                     candidates.push(item.text);

      // Quality checks — returns null if the text is unusable
      const isGibberish = (t: string): boolean => {
        if (!t || t.trim().length === 0) return true;
        const words = t.trim().split(/\s+/);
        // Spaced-out OCR noise: avg word length < 2 chars (e.g. "ی س 8 ری 8 ش")
        const avgWordLen = t.replace(/\s+/g, '').length / words.length;
        if (avgWordLen < 2) return true;
        // Mostly latin/digits in a Persian newspaper = garbled OCR
        const persianChars = (t.match(/[\u0600-\u06FF]/g) || []).length;
        const totalChars = t.replace(/\s/g, '').length;
        if (totalChars > 20 && persianChars / totalChars < 0.3) return true;
        return false;
      };

      // Pick the first candidate that passes quality checks
      let bestText: string | null = null;
      for (const candidate of candidates) {
        if (!isGibberish(candidate)) {
          bestText = candidate.trim();
          break;
        }
      }

      // Minimum useful length: skip page decorations, bylines, section labels.
      // A segment must have at least 30 chars of real content to be worth showing.
      // (Bylines like "معاون اول رییس جمهور :." are ~25 chars)
      if (!bestText || bestText.length < 30) return null;

      return {
        id: item.id || `newspaper-${item.timestamp}-${Math.random()}`,
        text: bestText,
        title: null,   // newspapers have no separate title field
        fullText: null,
        sourceType: source,
        screenName: item.name_fa || item.name || null,   // newspaper name in Farsi
        userId: item.name || null,
        userFollowers: 0,
        publisherRank: null,
        viewCount: 0,
        likeCount: 0,
        retweetCount: 0,
        replyCount: 0,
        quoteCount: 0,
        bookmarkCount: 0,
        hashtags: Array.isArray(item.text_tags) ? item.text_tags : [],
        publishedAt: item.timestamp
          ? new Date(item.timestamp * 1000).toISOString()
          : item.created_at ? new Date(item.created_at * 1000).toISOString() : null,
        postType: 'article',
        sentiment: this.numericSentimentToLabel(item.sentiment),
        // Show the cropped segment image; fall back to page thumb, then cover
        mediaUrl: segmentImg || pageThumb || coverImg || null,
        articleUrl: null,
        postUrl: null,
        topic: item.topic || null,
        // Extra newspaper-specific fields for the drawer
        pageNum: item.page_num || null,
        jdate: item.jdate || null,
        locationTags: null,
        _raw: item,
      };
    }

    // --- Media (TV/radio clips) ---
    if (source === 'media') {
      const videoDuration = item.video?.duration || item.audio?.duration || null;
      const thumbnail = item.video?.thumbnail || null;
      return {
        id: String(item.id),
        text: item.text || '',
        sourceType: source,
        screenName: item.channel?.name || item.channel?.id || null,
        userId: item.channel?.id || null,
        userFollowers: 0,
        viewCount: item.metadata?.views || item.impression || 0,
        likeCount: 0,
        retweetCount: 0,
        replyCount: 0,
        quoteCount: 0,
        bookmarkCount: 0,
        hashtags: [],
        publishedAt: item.timestamp
          ? new Date(item.timestamp * 1000).toISOString()
          : item.created_at ? new Date(item.created_at * 1000).toISOString() : null,
        postType: item.channel?.media_type || 'media',
        sentiment: this.numericSentimentToLabel(item.sentiment),
        mediaUrl: thumbnail || item.stream_url || item.multimedia_uri || null,
        postUrl: item.stream_url || null,
        duration: videoDuration,
        _raw: item,
      };
    }

    // --- Aparat / YouTube (video) ---
    if (source === 'aparat') {
      // title = video title (short, shown as card header)
      // text  = video description (long, may contain the keyword match)
      // Both need to be searchable/highlightable.
      const videoTitle = item.title || '';
      const videoDesc  = item.text && item.text !== item.title ? item.text : null;

      // Merge hashtags from text_hashtags + tags arrays
      const hashtags = [
        ...(Array.isArray(item.text_hashtags) ? item.text_hashtags : []),
        ...(Array.isArray(item.tags) ? item.tags : []),
      ].filter((v, i, a) => v && a.indexOf(v) === i);

      return {
        id: String(item.uid || item.id),
        // Card shows title; description shown in drawer
        text: videoTitle,
        fullText: videoDesc,
        title: null,   // title IS the text for videos — no separate title row needed
        sourceType: source,
        // channel.username is the @handle; channel.title is the display name
        screenName: item.channel?.username || item.channel?.title || item.channel?.id || null,
        displayName: item.channel?.title || null,
        userId: item.channel?.id || null,
        userFollowers: item.channel?.followers || 0,
        profileImageUrl: item.channel?.avatar || item.channel?.profile || null,
        viewCount: item.views || item.impression || 0,
        likeCount: item.likes || 0,
        retweetCount: 0,
        replyCount: item.comments_count || 0,
        quoteCount: 0,
        bookmarkCount: 0,
        hashtags,
        publishedAt: item.timestamp
          ? new Date(item.timestamp * 1000).toISOString()
          : item.created_at ? new Date(item.created_at * 1000).toISOString() : null,
        postType: 'video',
        platform: item.platform || 'aparat',   // 'aparat' or 'youtube'
        sentiment: this.numericSentimentToLabel(item.sentiment),
        mediaUrl: item.poster || item.frame || null,
        postUrl: item.platform === 'youtube'
          ? `https://www.youtube.com/watch?v=${item.uid}`
          : item.uid ? `https://www.aparat.com/v/${item.uid}` : null,
        duration: item.duration || null,
        topic: item.topic || null,
        _raw: item,
      };
    }

    // --- Fallback for any future source ---
    return {
      id: String(item.id || item.uid || Math.random()),
      text: item.text || item.title || '',
      sourceType: source,
      screenName: null,
      userId: null,
      userFollowers: 0,
      viewCount: item.views || item.impression || 0,
      likeCount: 0,
      retweetCount: 0,
      replyCount: 0,
      quoteCount: 0,
      bookmarkCount: 0,
      hashtags: [],
      publishedAt: item.timestamp ? new Date(item.timestamp * 1000).toISOString() : null,
      postType: null,
      sentiment: 'neutral',
      _raw: item,
    };
  }

  async test8tag(credentials: any, params: any): Promise<any> {
    // test8tag delegates to search8tag for a quick connectivity check
    return this.search8tag(credentials, {
      ...params,
      size: params.size || 10,
    });
  }

  async list8tagPages(credentials: any): Promise<any> {
    try {
      const domain = 'https://d1.8tag.ir';
      const token = await this.get8tagToken(credentials);

      const pagesResponse = await axios.post(
        `${domain}/api/v4/pages`,
        { token },
        { headers: { 'Content-Type': 'application/json' } },
      );
      const pages: any[] = pagesResponse.data.result || [];

      return {
        status: 'success',
        count: pages.length,
        pages: pages.map((p) => ({ id: p.id, name: p.name, source: p.source })),
      };
    } catch (error) {
      throw new HttpException(`8tag API Error: ${error.message}`, HttpStatus.BAD_REQUEST);
    }
  }
}

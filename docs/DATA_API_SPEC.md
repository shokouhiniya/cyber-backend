# Data Provider API Specification

This document defines the HTTP API contract our application expects from a social media and news monitoring data provider. A provider implementing this spec can be plugged in by changing only the base URL and API key.

---

## 1. Authentication

### Preferred: Static API Key

A long-lived API key issued once per client. Sent in the `Authorization` header:

```
Authorization: Bearer <api_key>
```

The key must remain valid until explicitly revoked. No rotation, no expiry, no session refresh logic on the client side.

### Fallback: Session Token

If a static key is not feasible, a session-token model is acceptable with these constraints:

- A single login endpoint exchanges username/password for a JWT
- Token TTL ≥ 7 days
- The token's `exp` claim must be parseable from the JWT payload (standard RFC 7519)

```http
POST /auth/login
Content-Type: application/json

{ "username": "...", "password": "..." }
```

```json
{ "status": 200, "result": "<jwt_token>" }
```

The same `Authorization: Bearer <token>` header is used for subsequent requests.

---

## 2. Search Endpoint

A single endpoint serves all post retrieval needs across every source type.

```http
POST /search
Content-Type: application/json
Authorization: Bearer <api_key>
```

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | `string \| string[]` | yes | Source identifier(s). See §3 for valid values. Array enables multi-source merge. |
| `or` | `string` | no | Pipe-separated keywords. A post matches if **at least one** appears. |
| `and` | `string` | no | Pipe-separated keywords. A post matches if **all** appear. |
| `not` | `string` | no | Pipe-separated keywords. Posts containing any of these are excluded. |
| `range` | `string` | yes | `day`, `yesterday`, `week`, `month`, `year`, `all`, or `custom`. |
| `since` | `number` | conditional | Unix timestamp (seconds). Required when `range=custom`. |
| `max` | `number` | conditional | Unix timestamp (seconds). Required when `range=custom`. |
| `sort` | `string` | yes | See §4 for valid values per source. |
| `size` | `number` | yes | Max results to return. Range: 1–1000. Default: 100. |
| `lang` | `string` | no | Filter by language: `fa`, `ar`, `en`, `all`. Default: `all`. |
| `forward` | `'true' \| 'false'` | no | Include forwarded/cross-posted content. Default: `false`. |
| `retweet` | `'true' \| 'false'` | no | Include retweets (Twitter only). Default: `false`. |
| `reply` | `'true' \| 'false'` | no | Include replies. Default: `true`. |
| `quote` | `'true' \| 'false'` | no | Include quote-tweets. Default: `true`. |
| `publishers` | `string[]` | no | Restrict to a list of publisher/channel identifiers. |

### Keyword Matching Rules

When matching `or`, `and`, `not` against post content, the provider must apply these normalisations on **both** sides of the comparison:

- Strip Arabic diacritics (harakat, U+064B–U+065F)
- Strip Arabic tatweel/kashida (U+0640)
- Treat ZWNJ (U+200C), ZWJ (U+200D), and whitespace as equivalent
- Treat Arabic ye `ي` (U+064A) and Persian ye `ی` (U+06CC) as equivalent
- Treat Arabic kaf `ك` (U+0643) and Persian kaf `ک` (U+06A9) as equivalent

Example: `جنتی` must match `جَنتی`, `احمد جنتی` must match `احمد‌جنتی`, `قالیباف` must match `قاليباف`.

### Response Envelope

```json
{
  "status": 200,
  "total": 12345,
  "result": [ /* array of normalised post objects, see §5 */ ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `number` | HTTP-style status code. `200` indicates success. |
| `total` | `number` | Total matches available across all pages. |
| `result` | `object[]` | Up to `size` post objects. |
| `error` | `string` | Present only on error responses. |

---

## 3. Source Types

The provider must support these source identifiers. Sources we don't yet need can be omitted, but the contract for those listed is required.

| Identifier | Description |
|------------|-------------|
| `telegram` | Telegram public channels |
| `bale` | Bale messenger public channels |
| `rubika` | Rubika messenger public channels |
| `eitaa` | Eitaa messenger public channels |
| `twitter` | X/Twitter public posts |
| `instagram` | Instagram public posts |
| `news` | Online news websites |
| `newspaper` | OCR'd print newspaper scans |
| `media` | TV/radio broadcasts (with speech-to-text) |
| `forum` | Public discussion forums |
| `aparat` | Aparat and YouTube videos |

When `source` is an array, the provider should merge results across sources, sorted by `publishedAt` descending unless another sort is requested. The `total` field returns the sum of all source totals.

---

## 4. Sort Options

Each source supports its own sort vocabulary. `recent` (newest first) and `old` (oldest first) must be supported by every source.

### Common (all sources)
- `recent` — newest first
- `old` — oldest first
- `random` — random order
- `score` — relevance score

### Engagement metrics (where applicable)
- `views` — most viewed
- `likes` — most liked / reacted
- `forwards` — most forwarded / shared / reposted
- `comments` — most commented
- `bookmarks` — most bookmarked (Twitter)
- `engagement` — composite engagement score
- `member` — most followers / channel members
- `followers` — most user followers
- `reactions` — most emoji reactions (messaging platforms)
- `source_influence` — publisher rank (news only)
- `copies` — most copied (news only)

### Threshold-based pagination

When a minimum-engagement filter is set (e.g. `minViews=1000`), the provider should:
1. Automatically sort by the matching metric
2. Paginate through results until the metric falls below the threshold
3. Return the count of qualifying posts as `total` if known

Recognised threshold params: `minViews`, `minLikes`, `minRetweets`, `minReplies`, `minQuotes`, `minBookmarks`, `minFollowers`.

---

## 5. Post Object Shape

Each post in the `result` array must conform to this normalised shape. Fields not applicable to a source should be `null` rather than omitted.

### Common fields (all sources)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Stable unique identifier across requests. **Must not vary between cached snapshots of the same post.** |
| `text` | `string` | Main post body or transcript. |
| `sourceType` | `string` | The source identifier (e.g. `"telegram"`). |
| `screenName` | `string \| null` | Username/handle of the poster or channel. |
| `displayName` | `string \| null` | Human-readable display name (where it differs from screenName). |
| `userId` | `string \| null` | Stable numeric or string ID of the poster. |
| `userFollowers` | `number` | Follower / subscriber / member count. `0` if unknown. |
| `profileImageUrl` | `string \| null` | URL to the poster's profile picture. |
| `viewCount` | `number` | View count. `0` if not tracked. |
| `likeCount` | `number` | Likes or total reactions. |
| `retweetCount` | `number` | Retweets / forwards / shares / reposts. |
| `replyCount` | `number` | Comments / replies. |
| `quoteCount` | `number` | Quote-tweets (Twitter). `0` for others. |
| `bookmarkCount` | `number` | Bookmarks (Twitter). `0` for others. |
| `hashtags` | `string[]` | Extracted hashtags (without `#` prefix). |
| `publishedAt` | `string` | ISO 8601 timestamp in UTC. |
| `postType` | `string \| null` | e.g. `"text"`, `"photo"`, `"video"`, `"retweet"`, `"quote"`, `"reply"`, `"article"`. |
| `sentiment` | `'positive' \| 'negative' \| 'neutral'` | Sentiment label. Use `"neutral"` if not analysed. |
| `mediaUrl` | `string \| null` | Direct URL to attached image/video, or thumbnail. |
| `postUrl` | `string \| null` | Permalink to the original post on the source platform. |

### Source-specific extensions

#### Twitter / X

```json
{
  "displayName": "Display Name",
  "screenName": "user_handle",
  "retweetUser": "original_handle",   // when postType == "retweet"
  "hasImage": true,
  "hasVideo": false
}
```

`postUrl` format: `https://x.com/<screenName>/status/<id>`

#### Instagram

```json
{
  "screenName": "username",
  "displayName": "Full Name",
  "profileImageUrl": "https://.../profile_pic.jpg"
}
```

`postUrl` format: `https://instagram.com/p/<postCode>` if `postCode` is known.

#### Telegram / Eitaa

These platforms typically don't expose channel avatars or numeric sentiment.

```json
{
  "screenName": "channel_username",
  "displayName": "Channel Title",
  "profileImageUrl": null,
  "reactions": [{ "reaction": "👍", "count": 42 }]   // telegram only
}
```

#### Bale / Rubika

Similar to Telegram but with avatar URLs and numeric sentiment.

```json
{
  "screenName": "channel_username",
  "displayName": "Channel Title",
  "profileImageUrl": "https://.../avatar.jpg",
  "reactions": [{ "reaction": "❤️", "count": 12 }]
}
```

#### News (online news sites)

```json
{
  "title": "Article headline",
  "text": "Short summary or first paragraph",   // ≥ 15 chars when meaningful
  "fullText": "Full article body",               // null if same as text
  "screenName": "Publisher Name",
  "publisherRank": 4,                            // source influence score
  "articleUrl": "https://...",
  "topic": "اقتصاد",
  "locationTags": { "city": [...], "province": [...] },
  "mediaUrl": "https://.../hero_image.jpg"
}
```

#### Newspaper (OCR'd print)

Newspaper posts are individual OCR segments from scanned pages. They have no URL.

```json
{
  "id": "<paper>_<jdate>_<page>_<segment>",     // e.g. "Arman-meli_14050222_2_6"
  "screenName": "آرمان ملی",                    // newspaper name in Persian
  "text": "Best available OCR text",
  "pageNum": 2,
  "jdate": "14050222",                            // Jalali date YYYYMMDD
  "topic": "سیاست",
  "mediaUrl": "https://.../segment_crop.jpg"   // cropped segment image
}
```

The provider should pick the best-quality OCR text available and indicate which field was selected, so the client can fall back if needed. Garbled segments (single words, headers, page numbers) should ideally be filtered server-side.

#### Media (TV/radio broadcasts)

```json
{
  "screenName": "channel_id",
  "displayName": "Channel Name",
  "text": "Speech-to-text transcript",
  "duration": 39,                                 // seconds
  "mediaUrl": "https://.../thumbnail.jpg",
  "postUrl": "https://.../stream.m3u8"
}
```

Low-quality STT output (very short avg word length, high repetition) should ideally be flagged or filtered.

#### Aparat / YouTube

```json
{
  "id": "<video_uid>",
  "platform": "aparat" | "youtube",
  "screenName": "channel_username",
  "displayName": "Channel Title",
  "text": "Video title",
  "fullText": "Full video description",
  "profileImageUrl": "https://.../channel_avatar.jpg",
  "duration": 500,                                // seconds
  "mediaUrl": "https://.../poster.jpg",
  "postUrl": "https://www.youtube.com/watch?v=<uid>" | "https://www.aparat.com/v/<uid>"
}
```

The `platform` field distinguishes Aparat from YouTube content within the same `aparat` source category.

#### Forum

```json
{
  "screenName": "username_or_platform",
  "userFollowers": 100,
  "text": "Post body",
  "postType": "post" | "reply" | "retweet"
}
```

---

## 6. Reactions Format

For platforms that expose emoji reactions, the field is a uniform array regardless of source:

```json
"reactions": [
  { "reaction": "👍", "count": 142 },
  { "reaction": "❤️", "count": 87 },
  { "reaction": "🔥", "count": 23 }
]
```

`null` when reactions aren't available.

---

## 7. Sentiment

Two acceptable formats:

1. **String label** (preferred): `"positive"`, `"negative"`, `"neutral"`
2. **Numeric**: `1` (positive), `0` (neutral), `-1` (negative)

The provider should pick one and use it consistently across all sources. Mixed responses are acceptable as long as the numeric → label mapping above is honoured.

---

## 8. Language Filtering

When `lang=fa` is passed, the provider must return only Persian-language posts.

If the source platform doesn't expose a reliable language field (common for messaging platforms), the provider should perform character-based filtering using these rules:

- Persian-specific characters: ک گ چ پ ژ ی ۰-۹
- Arabic-only characters: ك ي ة ى ئ ؤ
- A post is non-Persian if Arabic-only chars outnumber Persian-only chars 3:1 or more
- Urdu markers (ے ں ٹ ڈ ڑ) → exclude when `lang=fa`
- Kurdish markers (ڤ ێ ۆ, or 2+ of ڵ ڕ ە) → exclude when `lang=fa`

If the provider cannot perform this filtering, the `lang` parameter should still be accepted (and ignored) so the client-side filter has consistent input.

---

## 9. Pages / Channels Endpoint

A secondary endpoint that lists channels/pages the account is subscribed to.

```http
POST /pages
Authorization: Bearer <api_key>
```

```json
{
  "status": 200,
  "result": [
    { "id": "12345", "name": "Channel Name", "source": "telegram" }
  ]
}
```

---

## 10. Error Handling

Errors return an HTTP status code matching the situation:

| HTTP | Meaning |
|------|---------|
| 200 | Success |
| 400 | Malformed request — missing required field, invalid value |
| 401 | Authentication failed — invalid or expired token |
| 403 | Forbidden — account doesn't have access to this source/data |
| 416 | Range out of bounds — requested time range exceeds account's history |
| 429 | Rate limit reached |
| 5xx | Server error |

Error response body:

```json
{
  "status": 400,
  "error": "Human-readable message in English or Persian"
}
```

The client surfaces the `error` string to the end user, so it should be concise and user-friendly.

---

## 11. Rate Limiting

The provider should publish:
- Requests per minute
- Requests per day
- Recommended back-off behaviour on 429

The client respects `Retry-After` headers if returned.

---

## 12. Operational Requirements

- **Latency**: 95th percentile response time < 5 seconds for `size ≤ 100` queries
- **Pagination**: when `range=custom` is used with `since`/`max`, the provider must allow cursoring backwards through history without missing or duplicating posts
- **ID stability**: `id` field for a given post must be identical across requests, even if other fields (view counts, reactions) change. The client uses this for deduplication.
- **Time consistency**: all timestamps in ISO 8601 UTC. The client converts to local time for display.
- **Character encoding**: UTF-8 throughout. Persian/Arabic/Kurdish/Urdu text returned as-is, no escaping.

---

## 13. Migration Path

To replace an existing provider, the client only needs to change two things:

1. Base URL (e.g. `https://api.example.com`)
2. API key

No code changes, no field mapping changes. All sources, sort options, filter params, and response shapes match this spec exactly.

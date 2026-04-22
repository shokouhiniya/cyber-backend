# 8tag Page-Specific Data Retrieval Guide

## Overview
The 8tag API integration now supports fetching data for specific pages instead of all pages at once. This allows for targeted data collection and analysis.

## Page IDs for "دکتر آقامیری"

Based on the URL structure and API response, the following page IDs belong to "دکتر آقامیری":

- **231521**: News source
- **231522**: Telegram source  
- **231523**: Twitter source
- **231524**: Instagram source
- **231525**: Newspaper source
- **231526**: Comment source
- **231527**: TGG (Telegram Group) source
- **231528**: Media source

## How to Query a Specific Page

### Method 1: Using Page ID
```json
{
  "pageId": "231521",
  "keyword": "optional search term",
  "startDate": "2026-04-01",
  "endDate": "2026-04-20",
  "limit": 50,
  "sort": "recent"
}
```

### Method 2: Using Page Name
```json
{
  "pageName": "دکتر آقامیری",
  "keyword": "optional search term",
  "startDate": "2026-04-01",
  "endDate": "2026-04-20",
  "limit": 50
}
```

## API Endpoints

### 1. List All Available Pages
**Endpoint**: `POST /api/data-sources/:id/pages`

**Response**:
```json
{
  "status": "success",
  "count": 127,
  "pages": [
    {
      "id": 231521,
      "name": "دکتر آقامیری",
      "source": "news"
    }
  ]
}
```

### 2. Test/Fetch Page Data
**Endpoint**: `POST /api/data-sources/:id/test`

**Request Body**:
```json
{
  "pageId": "231521",
  "keyword": "",
  "startDate": "2026-04-01",
  "endDate": "2026-04-20",
  "limit": 50,
  "positive": true,
  "neutral": true,
  "negative": true,
  "sort": "recent"
}
```

**Response**:
```json
{
  "status": "success",
  "message": "8tag API connection successful - Page-specific data retrieved",
  "data": {
    "selectedPage": {
      "id": 231521,
      "name": "دکتر آقامیری",
      "source": "news"
    },
    "statistics": {
      // Sentiment and engagement metrics for this page
    },
    "posts": {
      "count": 50,
      "data": [
        // Array of posts with full details
      ],
      "filters": {
        "keyword": null,
        "startDate": "2026-04-01",
        "endDate": "2026-04-20",
        "sentiments": {
          "positive": true,
          "neutral": true,
          "negative": true
        },
        "sort": "recent"
      }
    }
  }
}
```

## Available Filters

### Sentiment Filters
- `positive`: Include positive sentiment posts (default: true)
- `neutral`: Include neutral sentiment posts (default: true)
- `negative`: Include negative sentiment posts (default: true)

### Sorting Options
- `recent`: Sort by most recent (default)
- `popular`: Sort by popularity/engagement

### Date Range
- `startDate`: Start date in YYYY-MM-DD format
- `endDate`: End date in YYYY-MM-DD format

### Keyword Search
- `keyword`: Search term to filter posts (optional)

### Limit
- `limit`: Number of results to return (max: 1000, default: 50)

## Frontend Usage

In the test page (http://localhost:3033/dashboard/test), you can now:

1. **Enter Page ID**: Directly specify the page ID (e.g., 231521)
2. **Enter Page Name**: Search by page name (e.g., "دکتر آقامیری")
3. **Set Date Range**: Filter posts by date
4. **Add Keywords**: Search within the page's posts
5. **Choose Sorting**: Recent or popular
6. **Set Limit**: Number of results to fetch

## Example: Fetching All Sources for دکتر آقامیری

To get data from all sources (News, Telegram, Twitter, Instagram, etc.) for دکتر آقامیری, you would make multiple requests with different page IDs:

```javascript
const pageIds = [231521, 231522, 231523, 231524, 231525, 231526, 231527, 231528];

for (const pageId of pageIds) {
  const response = await fetch('/api/data-sources/:id/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pageId: pageId.toString(),
      startDate: '2026-04-01',
      endDate: '2026-04-20',
      limit: 50
    })
  });
  
  const data = await response.json();
  console.log(`${data.data.selectedPage.source}: ${data.data.posts.count} posts`);
}
```

## Benefits of Page-Specific Queries

1. **Focused Data**: Get only the data you need
2. **Better Performance**: Smaller response sizes
3. **Easier Analysis**: Data is already filtered by source
4. **Precise Statistics**: Metrics specific to one page
5. **Reduced API Load**: Less data transfer

## Notes

- If no `pageId` or `pageName` is provided, the system defaults to the first available page
- Page names support partial matching (case-insensitive)
- The `statistics` endpoint provides sentiment analysis specific to the selected page
- All 127 available pages can be listed using the `/pages` endpoint

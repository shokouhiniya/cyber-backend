# 8tag (Hashtag) API Integration

## Overview
The 8tag integration successfully connects to the HomaPulse (Hashtag) Web Service to collect social media data from multiple sources including Telegram, Instagram, Twitter, News, and Rubika.

## Implementation Status
✅ **FULLY IMPLEMENTED AND TESTED**

## API Endpoints Used

### 1. Authentication
- **Endpoint**: `POST /api/v4/login`
- **Purpose**: Obtain JWT token for subsequent requests
- **Credentials**: Stored in environment variables
- **Response**: JWT token with expiration

### 2. Pages List
- **Endpoint**: `POST /api/v4/pages`
- **Purpose**: Retrieve list of dashboard pages and shared pages
- **Returns**: Array of pages categorized by source (Telegram, Instagram, Twitter, News, Rubika)

### 3. Statistics & Figures
- **Endpoint**: `POST /api/v4/figures`
- **Purpose**: Get comprehensive statistics across all active pages
- **Data Includes**:
  - Sentiment analysis (negative, neutral, positive)
  - Engagement metrics (likes, views, impressions, comments, shares)
  - Breakdown by source (Instagram, Twitter, Telegram, News, Newspaper)

### 4. Posts/Records
- **Endpoint**: `POST /api/v4/posts`
- **Purpose**: Fetch specific posts related to a page ID
- **Filters**: 
  - `since`: Start timestamp
  - `to`: End timestamp
  - `limit`: Max 1000 records per request
  - `offset`: For pagination

### 5. Online Search
- **Endpoint**: `POST /api/v4/search`
- **Purpose**: Broad searching across available sources
- **Parameters**:
  - `and/or/not`: Keyword logic (use | as separator)
  - `source`: telegram, twitter, instagram, news
  - `range`: day, week, month

## Test Results

### Successful Connection Test
- **Pages Retrieved**: 127 pages across multiple sources
- **Statistics**: Comprehensive figures with sentiment breakdown
- **Posts Sample**: 5 posts retrieved from Rubika
- **Search Results**: 100 recent Telegram posts

### Sample Data Structure

#### Pages Response
```json
{
  "count": 127,
  "list": [
    {
      "id": 280549,
      "name": "Page Name",
      "source": "rubika"
    }
  ]
}
```

#### Figures Response
```json
{
  "name": "Category Name",
  "instagram": {
    "count": "7 0 1",  // negative neutral positive
    "likes": "1076 0 68",
    "views": "52 0 1380",
    "comments": "102 0 16"
  },
  "telegram": {
    "count": "57 0 5",
    "views": "74151 0 3473",
    "unique": "51 0 5"
  },
  "twitter": {
    "count": "158 0 5",
    "impression": "32134 0 0",
    "likes": "467 0 0",
    "shares": "118 0 0"
  }
}
```

#### Posts Response
```json
{
  "record_id": 1057469319,
  "record_type": "rubika",
  "record_text": "Full post content...",
  "record_time": "Wed, 03 Dec 2025 23:54:46 GMT",
  "publisher_username": "username",
  "followers": 375,
  "num_views": 40,
  "num_likes": 0,
  "num_comments": 0,
  "sentiment": 0  // -1: negative, 0: neutral, 1: positive
}
```

## Error Handling

The integration handles all standard HTTP error codes:
- **400**: Bad Request - Missing parameters or invalid Content-Type
- **401**: Authentication Failed - Invalid credentials
- **403**: Forbidden - Invalid/expired token
- **429**: Rate Limit Reached - Monthly/daily limits exceeded
- **500**: Internal Server Error

## Environment Variables

```env
HASHTAG_URL=https://d1.8tag.ir
HASHTAG_USERNAME=majazi
HASHTAG_PASSWORD=TEqe7%4@
```

## Usage in Application

### Backend Service
The `DataSourceApiService.test8tag()` method handles:
1. Authentication and token acquisition
2. Fetching pages list
3. Retrieving comprehensive statistics
4. Fetching posts (if page ID available)
5. Performing keyword searches

### Frontend Test Page
Access via: http://localhost:3033/dashboard/test

Input fields:
- **Keyword**: Search term for online search
- **Start Date**: Filter posts from this date
- **End Date**: Filter posts until this date
- **Limit**: Number of results (max 1000)

## Data Sources Available

The account has access to 127 pages across:
- **Rubika**: Social messaging platform
- **Instagram**: Photo/video sharing
- **Twitter**: Microblogging
- **Telegram**: Messaging platform
- **News**: News websites
- **Newspaper**: Print media

## Next Steps

1. **Data Import**: Create scheduled jobs to regularly fetch and store data
2. **Sentiment Analysis**: Utilize the built-in sentiment scores
3. **Trend Detection**: Analyze figures over time
4. **Alert System**: Set up notifications for significant changes
5. **Dashboard Integration**: Display 8tag data in main dashboard views

## Performance Notes

- Token expiration is handled automatically with re-authentication
- Maximum 1000 records per request (use pagination for more)
- Rate limits apply to search functionality
- Response times are typically under 2 seconds

## Support

For API issues or questions:
- Check 8tag documentation
- Review error logs in backend console
- Contact 8tag support if credentials need updating

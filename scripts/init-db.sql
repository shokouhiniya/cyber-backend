CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN (
      'super_admin', 'client_admin', 'client_viewer',
      'admin', 'official', 'consultant'
    )),
    organization VARCHAR(255),
    avatar TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    role VARCHAR(255),
    organization VARCHAR(255),
    avatar TEXT,
    keywords TEXT[],
    excluded_keywords TEXT[],
    sort_criteria VARCHAR(50),
    plan VARCHAR(50),
    expires_at TIMESTAMP,
    primary_color VARCHAR(32),
    logo_url TEXT,
    promtic_identifier JSONB,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_profiles (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, profile_id)
);

CREATE TABLE IF NOT EXISTS data_sources (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('twitter', 'telegram', 'news', 'instagram')),
    api_endpoint TEXT,
    credentials JSONB,
    profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    params JSONB,
    schedule_cron VARCHAR(100),
    last_run_status VARCHAR(50),
    last_error TEXT,
    is_active BOOLEAN DEFAULT true,
    last_fetch_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS content (
    id VARCHAR(255) PRIMARY KEY,
    text TEXT NOT NULL,
    source_id UUID REFERENCES data_sources(id),
    source_type VARCHAR(50),
    profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    screen_name VARCHAR(255),
    user_id VARCHAR(255),
    user_followers INTEGER DEFAULT 0,
    user_following INTEGER DEFAULT 0,
    user_post_count INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    retweet_count INTEGER DEFAULT 0,
    reply_count INTEGER DEFAULT 0,
    quote_count INTEGER DEFAULT 0,
    bookmark_count INTEGER DEFAULT 0,
    sentiment VARCHAR(50),
    sentiment_score DECIMAL(5,4),
    emotion VARCHAR(50),
    emotion_score DECIMAL(5,4),
    lang VARCHAR(10),
    published_at TIMESTAMP,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    verified_at TIMESTAMP,
    is_verified BOOLEAN DEFAULT false,
    conversation_id VARCHAR(255),
    in_reply_to_id VARCHAR(255),
    in_reply_to_user_id VARCHAR(255),
    hashtags TEXT[],
    user_mentions TEXT[],
    urls TEXT[],
    raw_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS global_context (
    id SERIAL PRIMARY KEY,
    key VARCHAR(100) UNIQUE NOT NULL,
    value TEXT,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100),
    entity_id VARCHAR(255),
    diff JSONB,
    ip VARCHAR(64),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS usage_event (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    event_type VARCHAR(50) NOT NULL,
    event_name VARCHAR(100) NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Legacy tables kept for compatibility with any external scripts; unused in code.
CREATE TABLE IF NOT EXISTS keywords (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    keyword VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    type VARCHAR(50) NOT NULL CHECK (type IN ('pdf', 'excel', 'csv')),
    file_path TEXT,
    filters JSONB,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    action VARCHAR(255) NOT NULL,
    resource_type VARCHAR(100),
    resource_id VARCHAR(255),
    ip_address INET,
    user_agent TEXT,
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_content_published_at    ON content(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_sentiment       ON content(sentiment);
CREATE INDEX IF NOT EXISTS idx_content_emotion         ON content(emotion);
CREATE INDEX IF NOT EXISTS idx_content_screen_name     ON content(screen_name);
CREATE INDEX IF NOT EXISTS idx_content_verified        ON content(is_verified);
CREATE INDEX IF NOT EXISTS idx_content_source_type     ON content(source_type);
CREATE INDEX IF NOT EXISTS idx_content_profile_id      ON content(profile_id);
CREATE INDEX IF NOT EXISTS idx_content_text_search     ON content USING gin(to_tsvector('english', text));
CREATE INDEX IF NOT EXISTS idx_data_sources_profile_id ON data_sources(profile_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id   ON user_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_profile_id ON user_profiles(profile_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_event_profile_id  ON usage_event(profile_id);
CREATE INDEX IF NOT EXISTS idx_usage_event_event_name  ON usage_event(event_name);
CREATE INDEX IF NOT EXISTS idx_usage_event_created_at  ON usage_event(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_keywords_user_id        ON keywords(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id      ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at   ON audit_logs(created_at DESC);

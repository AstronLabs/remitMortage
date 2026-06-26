-- Add anonymized_at column to users table for GDPR tracking
ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- Index for efficient querying of pending anonymizations
CREATE INDEX IF NOT EXISTS idx_users_anonymization_pending 
    ON users(deactivated_at, anonymized_at) 
    WHERE deactivated_at IS NOT NULL AND anonymized_at IS NULL;

-- Index for anonymized users queries
CREATE INDEX IF NOT EXISTS idx_users_anonymized_at 
    ON users(anonymized_at) 
    WHERE anonymized_at IS NOT NULL;
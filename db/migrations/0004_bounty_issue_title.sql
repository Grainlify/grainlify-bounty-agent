-- The issue title, stored when the bounty is posted, so the public pages can
-- show it without a GitHub call per visitor.
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS issue_title TEXT;

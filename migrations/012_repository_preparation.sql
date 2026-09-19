-- A repository attachment now exists from the moment it is asked for, not from
-- the moment its clone finishes, so the workspace can show it being prepared
-- instead of holding a modal open for the length of a clone.
ALTER TABLE workspace_repositories
ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';

ALTER TABLE workspace_repositories
ADD COLUMN status_error TEXT;

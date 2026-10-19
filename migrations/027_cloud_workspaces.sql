-- A local workspace's twin on a cloud gateway. The gateway names workspaces
-- by UUID, because Kubernetes names its namespace objects after them, while
-- a local workspace's id is its slug; this row joins the two. Not a foreign
-- key: a cloud workspace can outlive the local one and still be deleted.
CREATE TABLE cloud_workspaces (
  workspace_id TEXT PRIMARY KEY,
  cloud_id TEXT NOT NULL UNIQUE
);

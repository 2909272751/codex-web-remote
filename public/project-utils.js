export function normalizeClientPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase("en-US");
}

export function projectRootPaths(project) {
  const roots = Array.isArray(project?.roots) ? project.roots : [];
  const paths = roots
    .map((root) => typeof root === "string" ? root : root?.path || root?.root || "")
    .map((root) => String(root || "").trim())
    .filter(Boolean);
  if (paths.length) return paths;
  return project?.path ? [String(project.path)] : [];
}

export function projectContainsPath(projectPath, candidatePath) {
  const project = normalizeClientPath(projectPath);
  const candidate = normalizeClientPath(candidatePath);
  return Boolean(project && candidate && (candidate === project || candidate.startsWith(`${project}/`)));
}

export function projectMatchesThread(project, candidatePath) {
  return projectRootPaths(project).some((root) => projectContainsPath(root, candidatePath));
}

export function timestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function threadTimestamp(thread) {
  return Math.max(
    timestampMs(thread?.recencyAt),
    timestampMs(thread?.updatedAt),
    timestampMs(thread?.createdAt),
    0,
  );
}
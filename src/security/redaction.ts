import { minimatch } from "minimatch";

const blockedPatterns = [
  "**/.env",
  "**/.env.*",
  "**/.envrc",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/.git-credentials",
  "**/.docker/config.json",
  "**/.kube/config",
  "**/kubeconfig",
  "**/.aws/credentials",
  "**/.azure/accessTokens.json",
  "**/application_default_credentials.json",
  "**/*service-account*.json",
  "**/*service_account*.json",
  "**/credentials",
  "**/credentials.*",
  "**/secrets",
  "**/secrets.*",
  "**/*.tfstate",
  "**/*.tfstate.*",
  "**/*.tfvars",
  "**/*.pem",
  "**/*.key",
  "**/*.pfx",
  "**/*.p12",
  "**/*.jks",
  "**/*.keystore",
  "**/id_rsa",
  "**/.ssh/id_*",
  "**/node_modules/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
];

const credentialKey = String.raw`(?:access[_-]?key|access[_-]?token|account[_-]?key|api[_-]?key|authorization|client[_-]?secret|connection[_-]?string|database[_-]?url|password|passwd|private[_-]?key|refresh[_-]?token|sas[_-]?token|secret|token)`;

const secretPatterns: readonly [RegExp, string][] = [
  [/\bAuthorization\s*:\s*[^\r\n]+/gi, "Authorization: [REDACTED]"],
  [
    new RegExp(
      String.raw`^(\s*["']?${credentialKey}["']?\s*:\s*)[|>][-+]?[^\r\n]*(?:\r?\n(?:[ \t]+[^\r\n]*(?:\r?\n|$))*)`,
      "gim",
    ),
    "$1[REDACTED]\n",
  ],
  [
    new RegExp(
      String.raw`(["']?)(${credentialKey})\1(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)`,
      "gi",
    ),
    "$1$2$1$3[REDACTED]",
  ],
  [/\b(?:AccountKey|SharedAccessSignature|sig)\s*=\s*[^;\s]+/gi, "[REDACTED_CREDENTIAL]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]"],
  [/\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[REDACTED]@"],
  [/\b(?:gh[opusr]|github_pat|ado|pat)_[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]"],
  [
    /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
];

const residualSecretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  new RegExp(
    String.raw`["']?${credentialKey}["']?\s*[:=]\s*(?!\[REDACTED\])(?:"[^"]+"|'[^']+'|[^\s,}\]]+)`,
    "i",
  ),
];

export function isSensitivePath(path: string, documentationRoot = "generated-docs"): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const normalizedDocumentationRoot = documentationRoot.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    normalized === normalizedDocumentationRoot ||
    normalized.startsWith(`${normalizedDocumentationRoot}/`)
  )
    return true;
  return blockedPatterns.some((pattern) =>
    minimatch(normalized, pattern, { dot: true, nocase: true }),
  );
}

export function redactText(text: string): string {
  const redacted = secretPatterns.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    text,
  );
  return residualSecretPatterns.some((pattern) => pattern.test(redacted))
    ? "[REDACTED_SENSITIVE_CONTENT]"
    : redacted;
}

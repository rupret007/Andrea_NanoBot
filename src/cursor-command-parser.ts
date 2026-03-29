function parseBoolean(raw: string | undefined): boolean | null {
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}

function readFlagValue(
  args: string[],
  index: number,
): { value?: string; consumed: number } {
  const token = args[index];
  const equalsIndex = token.indexOf('=');
  if (equalsIndex > -1) {
    return {
      value: token.slice(equalsIndex + 1),
      consumed: 1,
    };
  }

  const nextToken = args[index + 1];
  if (nextToken && !nextToken.startsWith('--')) {
    return { value: nextToken, consumed: 2 };
  }

  return { value: undefined, consumed: 1 };
}

export function tokenizeCommandArguments(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaped) current += '\\';
  if (current) tokens.push(current);

  return tokens;
}

export interface ParsedCursorCreateCommand {
  promptText: string;
  model?: string;
  sourceRepository?: string;
  sourceRef?: string;
  sourcePrUrl?: string;
  branchName?: string;
  autoCreatePr?: boolean;
  openAsCursorGithubApp?: boolean;
  skipReviewerRequest?: boolean;
  errors: string[];
}

function readStringFlag(
  args: string[],
  index: number,
  label: string,
  errors: string[],
): { value?: string; consumed: number } {
  const { value, consumed } = readFlagValue(args, index);
  if (value === undefined || !value.trim()) {
    errors.push(`Missing value for ${label}.`);
    return { consumed };
  }
  return { value: value.trim(), consumed };
}

function readBooleanFlag(
  args: string[],
  index: number,
  label: string,
  errors: string[],
): { value?: boolean; consumed: number } {
  const token = args[index];
  const equalsIndex = token.indexOf('=');
  if (equalsIndex > -1) {
    const parsedInline = parseBoolean(token.slice(equalsIndex + 1));
    if (parsedInline === null) {
      errors.push(`Invalid boolean for ${label}. Use true/false.`);
      return { consumed: 1 };
    }
    return { value: parsedInline, consumed: 1 };
  }

  const nextToken = args[index + 1];
  if (nextToken && !nextToken.startsWith('--')) {
    const parsedNext = parseBoolean(nextToken);
    if (parsedNext !== null) {
      return { value: parsedNext, consumed: 2 };
    }
    return { value: true, consumed: 1 };
  }

  const parsed = parseBoolean(undefined);
  if (parsed === null) {
    errors.push(`Invalid boolean for ${label}. Use true/false.`);
    return { consumed: 1 };
  }
  return { value: parsed, consumed: 1 };
}

export function parseCursorCreateCommand(
  rawMessage: string,
): ParsedCursorCreateCommand {
  const tokens = tokenizeCommandArguments(rawMessage.trim());
  const args = tokens.slice(1);
  const positional: string[] = [];
  const errors: string[] = [];

  const parsed: ParsedCursorCreateCommand = {
    promptText: '',
    errors,
  };

  for (let i = 0; i < args.length; ) {
    const token = args[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      i += 1;
      continue;
    }

    const [flagNameRaw] = token.split('=', 1);
    const flagName = flagNameRaw.toLowerCase();

    if (
      flagName === '--model' ||
      flagName === '--repo' ||
      flagName === '--source-repo' ||
      flagName === '--ref' ||
      flagName === '--source-ref' ||
      flagName === '--pr' ||
      flagName === '--source-pr' ||
      flagName === '--branch'
    ) {
      const labelMap: Record<string, string> = {
        '--model': '--model',
        '--repo': '--repo',
        '--source-repo': '--source-repo',
        '--ref': '--ref',
        '--source-ref': '--source-ref',
        '--pr': '--pr',
        '--source-pr': '--source-pr',
        '--branch': '--branch',
      };
      const { value, consumed } = readStringFlag(
        args,
        i,
        labelMap[flagName],
        errors,
      );
      if (value) {
        if (flagName === '--model') parsed.model = value;
        if (flagName === '--repo' || flagName === '--source-repo') {
          parsed.sourceRepository = value;
        }
        if (flagName === '--ref' || flagName === '--source-ref') {
          parsed.sourceRef = value;
        }
        if (flagName === '--pr' || flagName === '--source-pr') {
          parsed.sourcePrUrl = value;
        }
        if (flagName === '--branch') parsed.branchName = value;
      }
      i += consumed;
      continue;
    }

    if (
      flagName === '--auto-pr' ||
      flagName === '--autopr' ||
      flagName === '--auto_create_pr' ||
      flagName === '--no-auto-pr' ||
      flagName === '--no-autopr' ||
      flagName === '--no-auto_create_pr' ||
      flagName === '--cursor-github-app' ||
      flagName === '--open-as-cursor-github-app' ||
      flagName === '--no-cursor-github-app' ||
      flagName === '--no-open-as-cursor-github-app' ||
      flagName === '--skip-reviewer' ||
      flagName === '--skip-reviewers' ||
      flagName === '--skip-reviewer-request' ||
      flagName === '--no-skip-reviewer' ||
      flagName === '--no-skip-reviewers' ||
      flagName === '--no-skip-reviewer-request'
    ) {
      if (
        flagName === '--no-auto-pr' ||
        flagName === '--no-autopr' ||
        flagName === '--no-auto_create_pr'
      ) {
        parsed.autoCreatePr = false;
        i += 1;
        continue;
      }
      if (
        flagName === '--no-cursor-github-app' ||
        flagName === '--no-open-as-cursor-github-app'
      ) {
        parsed.openAsCursorGithubApp = false;
        i += 1;
        continue;
      }
      if (
        flagName === '--no-skip-reviewer' ||
        flagName === '--no-skip-reviewers' ||
        flagName === '--no-skip-reviewer-request'
      ) {
        parsed.skipReviewerRequest = false;
        i += 1;
        continue;
      }

      const labelMap: Record<string, string> = {
        '--auto-pr': '--auto-pr',
        '--autopr': '--autopr',
        '--auto_create_pr': '--auto_create_pr',
        '--cursor-github-app': '--cursor-github-app',
        '--open-as-cursor-github-app': '--open-as-cursor-github-app',
        '--skip-reviewer': '--skip-reviewer',
        '--skip-reviewers': '--skip-reviewers',
        '--skip-reviewer-request': '--skip-reviewer-request',
      };
      const { value, consumed } = readBooleanFlag(
        args,
        i,
        labelMap[flagName],
        errors,
      );
      if (value !== undefined) {
        if (
          flagName === '--auto-pr' ||
          flagName === '--autopr' ||
          flagName === '--auto_create_pr'
        ) {
          parsed.autoCreatePr = value;
        }
        if (
          flagName === '--cursor-github-app' ||
          flagName === '--open-as-cursor-github-app'
        ) {
          parsed.openAsCursorGithubApp = value;
        }
        if (
          flagName === '--skip-reviewer' ||
          flagName === '--skip-reviewers' ||
          flagName === '--skip-reviewer-request'
        ) {
          parsed.skipReviewerRequest = value;
        }
      }
      i += consumed;
      continue;
    }

    errors.push(`Unknown option ${flagName}.`);
    i += 1;
  }

  parsed.promptText = positional.join(' ').trim();
  if (!parsed.promptText) {
    errors.push('Prompt text is required.');
  }

  return parsed;
}

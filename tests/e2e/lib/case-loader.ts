import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export interface TestCase {
  id: string;
  n: number;
  notes?: string;
  provider: string;
  page: string;
  url: string;
  status_manual?: string;
  status_e2e?: string;
  profile?: string;
  platform?: string;
  methods?: Array<{
    name?: string;
    priority?: number;
    manual?: string;
    detect?: {
      method?: string;
      selector?: string;
      embedUrl?: string;
      description?: string;
      expectedUrls?: Array<{ pattern?: string }>;
    };
    download?: {
      tool?: string;
      recipe?: string;
      command?: string;
    };
  }>;
  // Legacy flat structure for backward compatibility
  status?: string;
  detect?: {
    method?: string;
    selector?: string;
    embedUrl?: string;
  };
  download?: {
    tool?: string;
    command?: string;
  };
  expects: {
    detect?: boolean;
    inspect?: boolean;
    download?: boolean;
    hasAudio?: boolean;
    hasVideo?: boolean;
    ext?: string;
  };
}

interface CaseCatalogue {
  fields?: Record<string, unknown>;
  cases: TestCase[];
}

function isCaseCatalogue(payload: unknown): payload is CaseCatalogue {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const candidate = payload as Record<string, unknown>;
  return Array.isArray(candidate.cases);
}

let cache: Map<string, TestCase> | null = null;

function loadCatalogue(): Map<string, TestCase> {
  if (cache) {
    return cache;
  }

  const root = path.resolve(__dirname, '..', '..', 'cases.yaml');
  if (!fs.existsSync(root)) {
    throw new Error(`tests/cases.yaml not found at ${root}`);
  }

  const raw = fs.readFileSync(root, 'utf8');
  const parsed = parse(raw);
  if (!isCaseCatalogue(parsed)) {
    throw new Error('tests/cases.yaml has unexpected structure');
  }

  cache = new Map(parsed.cases.map(testCase => [testCase.id, testCase]));
  return cache;
}

export function getCase(caseId: string): TestCase {
  const catalogue = loadCatalogue();
  const result = catalogue.get(caseId);
  if (!result) {
    throw new Error(`Case with id "${caseId}" not found in tests/cases.yaml`);
  }
  return result;
}

export function clearCaseCache(): void {
  cache = null;
}

import fs from 'node:fs';
import path from 'node:path';

export interface ProfileLogin {
  emailEnv?: string;
  passwordEnv?: string;
}

export interface TestProfile {
  name: string;
  partition?: string;
  startUrl?: string;
  videoUrls?: string[];
  login?: ProfileLogin | null;
}

interface ProfileCatalogue {
  profiles: TestProfile[];
}

function isProfileCatalogue(payload: unknown): payload is ProfileCatalogue {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const candidate = payload as Record<string, unknown>;
  return Array.isArray(candidate.profiles);
}

let cache: Map<string, TestProfile> | null = null;

function loadProfiles(): Map<string, TestProfile> {
  if (cache) {
    return cache;
  }

  const configPath = path.resolve(__dirname, '..', '..', 'test-profiles.local.json');
  if (!fs.existsSync(configPath)) {
    cache = new Map();
    return cache;
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  const profiles = isProfileCatalogue(parsed) ? parsed.profiles : [];
  cache = new Map(profiles.map(profile => [profile.name, profile]));
  return cache;
}

export function getProfile(name?: string | null): TestProfile | null {
  if (!name) {
    return null;
  }
  const catalogue = loadProfiles();
  return catalogue.get(name) ?? null;
}

export function clearProfileCache(): void {
  cache = null;
}

import is from '@sindresorhus/is';
import toml from 'toml';
import { RANGE_PATTERN } from '@renovate/pep440/lib/specifier';
import { logger } from '../../logger';
import { PackageFile, PackageDependency } from '../common';
import * as datasourcePypi from '../../datasource/pypi';
import { SkipReason } from '../../types';

// based on https://www.python.org/dev/peps/pep-0508/#names
const packageRegex = /^([A-Z0-9]|[A-Z0-9][A-Z0-9._-]*[A-Z0-9])$/i;
const rangePattern = RANGE_PATTERN;

const specifierPartPattern = `\\s*${rangePattern.replace(
  /\?<\w+>/g,
  '?:'
)}\\s*`;
const specifierPattern = `${specifierPartPattern}(?:,${specifierPartPattern})*`;
interface PipSource {
  name: string;
  url: string;
}

interface PipFile {
  source: PipSource[];

  packages?: Record<string, PipRequirement>;
  'dev-packages'?: Record<string, PipRequirement>;
}

interface PipRequirement {
  index?: string;
  version?: string;
  path?: string;
  file?: string;
  git?: string;
}

function extractFromSection(
  pipfile: PipFile,
  section: 'packages' | 'dev-packages'
): PackageDependency[] {
  if (!(section in pipfile)) {
    return [];
  }
  const specifierRegex = new RegExp(`^${specifierPattern}$`);
  const pipfileSection = pipfile[section];

  const deps = Object.entries(pipfileSection)
    .map(x => {
      const [depName, requirements] = x;
      let currentValue: string;
      let nestedVersion: boolean;
      let skipReason: SkipReason;
      if (requirements.git) {
        skipReason = SkipReason.GitDependency;
      } else if (requirements.file) {
        skipReason = SkipReason.FileDependency;
      } else if (requirements.path) {
        skipReason = SkipReason.LocalDependency;
      } else if (requirements.version) {
        currentValue = requirements.version;
        nestedVersion = true;
      } else if (is.object(requirements)) {
        skipReason = SkipReason.AnyVersion;
      } else {
        currentValue = requirements;
      }
      if (currentValue === '*') {
        skipReason = SkipReason.AnyVersion;
      }
      if (!skipReason) {
        const packageMatches = packageRegex.exec(depName);
        if (!packageMatches) {
          logger.debug(
            `Skipping dependency with malformed package name "${depName}".`
          );
          skipReason = SkipReason.InvalidName;
        }
        const specifierMatches = specifierRegex.exec(currentValue);
        if (!specifierMatches) {
          logger.debug(
            `Skipping dependency with malformed version specifier "${currentValue}".`
          );
          skipReason = SkipReason.InvalidVersion;
        }
      }
      const dep: PackageDependency = {
        depType: section,
        depName,
        managerData: {},
      };
      if (currentValue) dep.currentValue = currentValue;
      if (skipReason) {
        dep.skipReason = skipReason;
      } else {
        dep.datasource = datasourcePypi.id;
      }
      if (nestedVersion) dep.managerData.nestedVersion = nestedVersion;
      if (requirements.index) {
        if (is.array(pipfile.source)) {
          const source = pipfile.source.find(
            item => item.name === requirements.index
          );
          if (source) {
            dep.registryUrls = [source.url];
          }
        }
      }
      return dep;
    })
    .filter(Boolean);
  return deps;
}

export function extractPackageFile(content: string): PackageFile | null {
  logger.debug('pipenv.extractPackageFile()');

  let pipfile: PipFile;
  try {
    pipfile = toml.parse(content);
  } catch (err) {
    logger.debug({ err }, 'Error parsing Pipfile');
    return null;
  }
  const res: PackageFile = { deps: [] };
  if (pipfile.source) {
    res.registryUrls = pipfile.source.map(source => source.url);
  }

  res.deps = [
    ...extractFromSection(pipfile, 'packages'),
    ...extractFromSection(pipfile, 'dev-packages'),
  ];
  if (res.deps.length) {
    return res;
  }
  return null;
}

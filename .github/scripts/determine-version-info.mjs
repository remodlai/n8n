import { readFile } from 'fs/promises';
import { resolve } from 'path';
import assert from 'assert';

/**
 * Parse the version from the package.json file
 */
export async function getPackageVersion() {
  const packageJsonPath = resolve(process.cwd(), 'package.json');
  const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
  const packageJson = JSON.parse(packageJsonContent);
  return packageJson.version;
}

/**
 * Determine the track for a version
 * 
 * @param {string} version - The version string (e.g. "1.0.0", "1.0.0-beta.1", "1.0.0-exp.0")
 * @returns {string} - The track (stable, beta, or experimental)
 * @throws {Error} - If track cannot be determined
 */
export function determineTrack(version, opts = {}) {
  // Default track is stable unless specified in version or opts
  let track = null;

  // Check if the version string contains a prerelease indicator
  if (version.includes('-beta.')) {
    track = 'beta';
  } else if (version.includes('-exp.')) {
    track = 'experimental';
  }

  // If no track was determined from the version, check if we're explicitly beta
  if (!track) {
    const hasBetaTag = opts.tags?.some(tag => tag === 'beta');
    
    if (!hasBetaTag) {
      throw new Error('Cannot determine track: version does not contain beta/exp suffix and no beta tag provided');
    }
    
    // Validate new beta releases
    if (opts.validateBeta !== false) {
      assertNewBetaRelease(version, opts.versions ?? []);
    }

    track = 'beta';
  }

  return track;
}

/**
 * Determine the release type from a version
 * 
 * @param {string} version - The version string
 * @returns {string} - Either 'stable' or 'prerelease'
 */
export function determineReleaseType(version) {
  // Consider both -rc. and -exp. as prerelease indicators
  if (version.includes('-rc.') || version.includes('-exp.')) {
    return 'prerelease';
  }
  return 'stable';
}

/**
 * Assert that a new beta version does not already exist
 * 
 * @param {string} version - The version to check
 * @param {string[]} existingVersions - Array of existing versions
 * @throws {Error} - If version already exists
 */
function assertNewBetaRelease(version, existingVersions) {
  if (existingVersions.includes(version)) {
    throw new Error(`Beta release ${version} already exists`);
  }
}

/**
 * Write Github output for use in GitHub Actions
 */
export function writeGithubOutput(outputs = {}) {
  // Get the GitHub output file path from env
  const outputFilePath = process.env.GITHUB_OUTPUT;
  if (!outputFilePath) {
    console.error('GITHUB_OUTPUT environment variable not set. Not writing outputs.');
    return;
  }

  // Format and write each output
  const outputsFormatted = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  
  console.log(`Writing outputs to ${outputFilePath}`);
  console.log(outputsFormatted);
  
  // In a real implementation, this would write to the file
  // await writeFile(outputFilePath, outputsFormatted, { flag: 'a' });
}

// Main execution if run directly
if (require.main === module) {
  (async () => {
    try {
      const version = await getPackageVersion();
      const track = determineTrack(version, { 
        tags: process.env.TAGS?.split(',') || [],
        versions: process.env.EXISTING_VERSIONS?.split(',') || [],
        validateBeta: process.env.VALIDATE_BETA !== 'false'
      });
      
      const release_type = determineReleaseType(version);
      
      writeGithubOutput({
        version,
        track,
        release_type
      });
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  })();
}
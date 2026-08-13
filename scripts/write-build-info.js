const fs = require('fs');
const path = require('path');
const infoPath = path.join(__dirname, '..', 'public', 'build-info.json');
const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

function normalizeBuildToken(value) {
  return (value || '').toString().trim().replace(/[^0-9A-Za-z-]+/g, '-').replace(/^-+|-+$/g, '');
}

const buildNumber = normalizeBuildToken(process.env.BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER);
const buildId = normalizeBuildToken(process.env.BUILD_ID);
const gitSha = normalizeBuildToken(
  process.env.RENDER_GIT_COMMIT ||
  process.env.GIT_COMMIT ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.GITHUB_SHA
);
const version = buildNumber
  ? `${pkg.version}+build.${buildNumber}`
  : buildId
    ? `${pkg.version}+build.${buildId}`
    : `${pkg.version}+${gitSha ? gitSha.slice(0, 7) : 'local'}`;

fs.writeFileSync(infoPath, JSON.stringify({ version }, null, 2) + '\n');

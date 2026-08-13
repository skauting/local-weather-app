const fs = require('fs');
const path = require('path');
const infoPath = path.join(__dirname, '..', 'public', 'build-info.json');
const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const buildNumber = Number(process.env.BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || '0');
const gitSha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || '';
const version = buildNumber > 0 ? `${pkg.version}+build.${buildNumber}` : `${pkg.version}${gitSha ? `+${gitSha.slice(0, 7)}` : ''}`;
fs.writeFileSync(infoPath, JSON.stringify({ version }, null, 2) + '\n');

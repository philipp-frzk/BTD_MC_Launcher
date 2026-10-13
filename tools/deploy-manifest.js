/**
 * Prepares the "deploy" release that the website's Raspberry Pi pulls from (see .github/workflows/deploy.yml).
 *
 *   node tools/deploy-manifest.js <work dir>
 *
 * Reads from <work dir>:
 *   current/manifest.json   manifest of the release (missing on the first run)
 *   launcher/               new launcher build: .exe, .exe.blockmap, latest.yml (optional)
 *   distro/                 new server list: distribution.json, versions/*.json, files/** (optional)
 * Writes:
 *   upload/                 new and changed assets plus manifest.json
 *   stale.txt               release assets that are no longer listed (to delete)
 *
 * The manifest lists the files in the order the Pi must write them: the Fabric version file and the
 * override files before distribution.json, the installer before latest.yml.
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const work = path.resolve(process.argv[2] ?? 'work')
const uploadDir = path.join(work, 'upload')
fs.mkdirSync(uploadDir, { recursive: true })

const currentPath = path.join(work, 'current', 'manifest.json')
const current = fs.existsSync(currentPath) ? JSON.parse(fs.readFileSync(currentPath, 'utf8')) : { files: [] }

/**
 * Stage a file for upload and return its manifest entry. Assets are flat, so the name comes from the target path;
 * files/ (modpack overrides) can repeat names in different folders, so those are named by content hash.
 */
function stage(source, target){
    const buf = fs.readFileSync(source)
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
    const asset = target.startsWith('files/') ? `file-${sha256.slice(0, 16)}` : path.basename(target)
    fs.writeFileSync(path.join(uploadDir, asset), buf)
    return { asset, path: target, size: buf.length, sha256 }
}

/** Every file under dir, as paths relative to it with forward slashes. */
function listFiles(dir, prefix = ''){
    if(!fs.existsSync(dir)){
        return []
    }
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory()
        ? listFiles(path.join(dir, d.name), `${prefix}${d.name}/`)
        : [`${prefix}${d.name}`])
}

let distroFiles = current.files.filter(f => !f.path.startsWith('launcher/'))
let launcherFiles = current.files.filter(f => f.path.startsWith('launcher/'))
let launcherVersion = current.launcherVersion ?? null

const distroDir = path.join(work, 'distro')
if(fs.existsSync(distroDir)){
    distroFiles = [
        ...listFiles(path.join(distroDir, 'versions'), 'versions/').map(f => stage(path.join(distroDir, f), f)),
        ...listFiles(path.join(distroDir, 'files'), 'files/').map(f => stage(path.join(distroDir, f), f)),
        stage(path.join(distroDir, 'distribution.json'), 'distribution.json')
    ]
}

const launcherDir = path.join(work, 'launcher')
if(fs.existsSync(launcherDir)){
    const latestYml = path.join(launcherDir, 'latest.yml')
    const installers = fs.readdirSync(launcherDir).filter(f => f !== 'latest.yml')
    launcherFiles = [
        ...installers.map(f => stage(path.join(launcherDir, f), `launcher/${f}`)),
        stage(latestYml, 'launcher/latest.yml')
    ]
    launcherVersion = /^version:\s*['"]?([^'"\r\n]+)/m.exec(fs.readFileSync(latestYml, 'utf8'))?.[1] ?? null
}

const manifest = { launcherVersion, files: [...distroFiles, ...launcherFiles] }
fs.writeFileSync(path.join(uploadDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

const listed = new Set(manifest.files.map(f => f.asset))
const stale = current.files.map(f => f.asset).filter(a => !listed.has(a))
fs.writeFileSync(path.join(work, 'stale.txt'), stale.map(a => `${a}\n`).join(''))

console.log(`Launcher ${launcherVersion ?? '(none)'}, ${manifest.files.length} files:`)
for(const f of manifest.files){
    console.log(`  ${f.path}`)
}
if(stale.length){
    console.log(`Removing from the release: ${stale.join(', ')}`)
}

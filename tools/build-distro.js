/**
 * Generates the launcher's server list from a Modrinth modpack export (.mrpack).
 *
 *   npm run distro                       (uses distro/modpack.mrpack, or opens a file dialog if it's missing)
 *   npm run distro "C:\path\to\pack.mrpack"
 *
 * Server details (address, name, description, paidUntil) come from distro/config.json.
 * Minecraft version, Fabric Loader version and the mods come from the modpack.
 *
 * Output, to upload to `baseUrl` on the web server:
 *   distro/output/distribution.json
 *   distro/output/versions/<fabric-profile-id>.json
 */
const AdmZip = require('adm-zip')
const { spawn, spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CONFIG_PATH = path.join(ROOT, 'distro', 'config.json')
const MODPACK_PATH = path.join(ROOT, 'distro', 'modpack.mrpack')
const OUTPUT_DIR = path.join(ROOT, 'distro', 'output')
const CACHE_DIR = path.join(ROOT, 'distro', '.cache')
const LAST_PICK_PATH = path.join(CACHE_DIR, 'last-modpack.txt')

const USER_AGENT = 'BTD-Launcher-distro-builder/1.0'
const MODRINTH_API = 'https://api.modrinth.com/v2'
const FABRIC_META = 'https://meta.fabricmc.net/v2'

const warnings = []

async function fetchOk(url, options = {}){
    const res = await fetch(url, { ...options, headers: { 'User-Agent': USER_AGENT, ...options.headers } })
    if(!res.ok){
        throw new Error(`${res.status} ${res.statusText} for ${url}`)
    }
    return res
}

/** Download a file (cached by URL) and return the launcher's artifact fields. */
async function artifactFor(url){
    const cacheFile = path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex'))
    let buf
    if(fs.existsSync(cacheFile)){
        buf = fs.readFileSync(cacheFile)
    } else {
        buf = Buffer.from(await (await fetchOk(url)).arrayBuffer())
        fs.writeFileSync(cacheFile, buf)
    }
    return { size: buf.length, MD5: crypto.createHash('md5').update(buf).digest('hex'), url }
}

/** Windows file dialog for the .mrpack, opening in the folder of the last pick. Returns null if cancelled. */
function pickModpackFile(){
    if(process.platform !== 'win32'){
        return null
    }
    const last = fs.existsSync(LAST_PICK_PATH) ? fs.readFileSync(LAST_PICK_PATH, 'utf8').trim() : ''
    const initialDir = last && fs.existsSync(path.dirname(last))
        ? path.dirname(last)
        : path.join(process.env.USERPROFILE || '', 'Downloads')
    const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
        '$d = New-Object System.Windows.Forms.OpenFileDialog',
        '$d.Title = "Select your Modrinth modpack export"',
        '$d.Filter = "Modrinth modpack (*.mrpack)|*.mrpack|All files (*.*)|*.*"',
        `$d.InitialDirectory = '${initialDir.replace(/'/g, '\'\'')}'`,
        'if($d.ShowDialog($owner) -eq "OK"){ $d.FileName }'
    ].join('; ')
    const picked = (spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8' }).stdout || '').trim()
    if(picked){
        fs.writeFileSync(LAST_PICK_PATH, picked)
    }
    return picked || null
}

/** net.fabricmc:intermediary:1.21.1 -> net/fabricmc/intermediary/1.21.1/intermediary-1.21.1.jar */
function mavenPath(id){
    const [group, artifact, version, classifier] = id.split(':')
    const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`
    return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`
}

/** Modrinth version numbers can contain characters that don't belong in a maven id. */
function mavenSafe(str){
    return str.replace(/[^A-Za-z0-9._+-]/g, '-')
}

/** Java requirement for a Minecraft version, read from Mojang's version manifest. */
async function javaOptionsFor(mcVersion){
    const manifest = await (await fetchOk('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json()
    const entry = manifest.versions.find(v => v.id === mcVersion)
    if(entry == null){
        throw new Error(`Minecraft ${mcVersion} is not in Mojang's version manifest.`)
    }
    const major = (await (await fetchOk(entry.url)).json()).javaVersion?.majorVersion
    return major != null ? { supported: `>=${major}`, suggestedMajor: major } : undefined
}

async function buildFabricModule(mcVersion, loaderVersion, baseUrl){
    // The version manifest is hosted next to distribution.json, so its MD5 never changes under us.
    const profileBuf = Buffer.from(await (await fetchOk(`${FABRIC_META}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`)).arrayBuffer())
    const profile = JSON.parse(profileBuf.toString('utf8'))
    fs.mkdirSync(path.join(OUTPUT_DIR, 'versions'), { recursive: true })
    fs.writeFileSync(path.join(OUTPUT_DIR, 'versions', `${profile.id}.json`), profileBuf)

    const manifestModule = {
        id: profile.id,
        name: 'Fabric (version.json)',
        type: 'VersionManifest',
        artifact: {
            size: profileBuf.length,
            MD5: crypto.createHash('md5').update(profileBuf).digest('hex'),
            url: new URL(`versions/${profile.id}.json`, baseUrl).href
        }
    }

    let loaderModule = null
    const libraries = []
    for(const lib of profile.libraries){
        const url = new URL(mavenPath(lib.name), lib.url.endsWith('/') ? lib.url : `${lib.url}/`).href
        const module = { id: lib.name, name: `Fabric (${lib.name.split(':')[1]})`, type: 'Library', artifact: await artifactFor(url) }
        if(lib.name.startsWith('net.fabricmc:fabric-loader:')){
            loaderModule = { ...module, type: 'Fabric' }
        } else {
            libraries.push(module)
        }
    }
    if(loaderModule == null){
        throw new Error('The Fabric profile has no fabric-loader library.')
    }
    loaderModule.subModules = [manifestModule, ...libraries]
    return loaderModule
}

/** The modpack's client mods as launcher modules, named via Modrinth where possible. */
async function buildModModules(packFiles){
    const mods = packFiles.filter(f => f.path.startsWith('mods/'))
    for(const f of mods.filter(f => f.env?.client === 'unsupported')){
        warnings.push(`${path.basename(f.path)} is server-only and was left out (install it on the server).`)
    }
    const clientMods = mods.filter(f => f.env?.client !== 'unsupported')

    const versions = await (await fetchOk(`${MODRINTH_API}/version_files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: clientMods.map(f => f.hashes.sha1), algorithm: 'sha1' })
    })).json()
    const projectIds = [...new Set(Object.values(versions).map(v => v.project_id))]
    const projects = await (await fetchOk(`${MODRINTH_API}/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`)).json()
    const projectById = Object.fromEntries(projects.map(p => [p.id, p]))

    const modules = []
    for(const file of clientMods){
        const artifact = await artifactFor(file.downloads[0])
        if(artifact.size !== file.fileSize){
            throw new Error(`Size mismatch while downloading ${file.downloads[0]}`)
        }
        const version = versions[file.hashes.sha1]
        const project = version ? projectById[version.project_id] : null
        const fileName = path.basename(file.path, '.jar')
        const slug = project ? project.slug : mavenSafe(fileName).toLowerCase()
        const versionNumber = version ? version.version_number : 'file'
        modules.push({
            id: `modrinth.${slug}:${slug}:${mavenSafe(versionNumber)}`,
            name: project ? `${project.title} (${versionNumber})` : fileName,
            type: 'FabricMod',
            artifact
        })
        console.log(`  ${(project ? project.title : fileName).padEnd(36)} ${versionNumber}`)
    }
    return modules
}

/** Prints whether the Minecraft server answers at its address (never fails the run). */
async function reportServerStatus(address){
    const [host, port = '25565'] = address.split(':')
    try {
        const { getServerStatus } = require('helios-core/mojang')
        const status = await getServerStatus(47, host, Number(port))
        console.log(`Server ${address}: online, ${status.players.online}/${status.players.max} players`)
    } catch (err) {
        warnings.push(`Server ${address} did not answer (${err.message || err}). Is the address right and the server running?`)
    }
}

async function main(){
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const { server } = config
    const baseUrl = config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`

    fs.mkdirSync(CACHE_DIR, { recursive: true })
    const packPath = process.argv[2] ?? (fs.existsSync(MODPACK_PATH) ? MODPACK_PATH : pickModpackFile())
    if(packPath == null){
        throw new Error('No modpack selected.')
    }
    const index = JSON.parse(new AdmZip(packPath).readAsText('modrinth.index.json'))
    const mcVersion = index.dependencies?.minecraft
    const loaderVersion = index.dependencies?.['fabric-loader']
    if(!mcVersion || !loaderVersion){
        throw new Error('The modpack is not a Fabric modpack (no minecraft / fabric-loader dependency).')
    }

    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true })
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
    console.log(`${path.basename(packPath)}: Minecraft ${mcVersion}, Fabric Loader ${loaderVersion}`)

    const fabricModule = await buildFabricModule(mcVersion, loaderVersion, baseUrl)
    const modModules = await buildModModules(index.files)
    const javaOptions = await javaOptionsFor(mcVersion)

    const serverEntry = {
        id: server.id,
        name: server.name,
        description: server.description,
        icon: server.icon || '',
        version: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
        address: server.address,
        minecraftVersion: mcVersion,
        mainServer: true,
        autoconnect: server.autoconnect !== false
    }
    if(server.paidUntil){
        serverEntry.paidUntil = server.paidUntil
    }
    if(javaOptions){
        serverEntry.javaOptions = javaOptions
    }
    serverEntry.modules = [fabricModule, ...modModules]
    fs.writeFileSync(path.join(OUTPUT_DIR, 'distribution.json'), JSON.stringify({ version: '1.0.0', servers: [serverEntry] }, null, 4) + '\n')

    console.log(`\n${modModules.length} mods, Java ${javaOptions?.suggestedMajor ?? '(launcher default)'}.`)
    await reportServerStatus(server.address)
    for(const w of warnings){
        console.warn(`WARNING: ${w}`)
    }

    console.log('\nUpload these files from distro/output/ to your web server (keep the folders):')
    for(const file of ['distribution.json', ...fs.readdirSync(path.join(OUTPUT_DIR, 'versions')).map(f => `versions/${f}`)]){
        console.log(`  ${file.padEnd(48)} -> ${new URL(file, baseUrl).href}`)
    }
    if(process.platform === 'win32'){
        spawn('explorer.exe', [OUTPUT_DIR], { detached: true, stdio: 'ignore' }).unref()
    }
}

main().catch(err => {
    console.error(`\nERROR: ${err.message}`)
    process.exit(1)
})

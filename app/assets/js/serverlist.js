/**
 * Keeps the distribution's server in Minecraft's in-game server list (servers.dat).
 *
 * servers.dat is an uncompressed NBT file: a root compound with a "servers" list of compounds
 * ({ name, ip, icon?, acceptTextures? }). Tags this module doesn't change are kept as raw bytes,
 * so whatever Minecraft stored for the player's other servers is written back untouched.
 */
const fs   = require('fs-extra')
const path = require('path')

const TAG_END      = 0
const TAG_BYTE     = 1
const TAG_STRING   = 8
const TAG_LIST     = 9
const TAG_COMPOUND = 10

/** Byte length of the fixed-size and array tags' payloads at `offset`. */
const RAW_SIZE = {
    1: () => 1,
    2: () => 2,
    3: () => 4,
    4: () => 8,
    5: () => 4,
    6: () => 8,
    7: (buf, o) => 4 + buf.readInt32BE(o),
    8: (buf, o) => 2 + buf.readUInt16BE(o),
    11: (buf, o) => 4 + 4 * buf.readInt32BE(o),
    12: (buf, o) => 4 + 8 * buf.readInt32BE(o)
}

/** Java's modified UTF-8, as NBT strings use it. */
function encodeString(str){
    const bytes = []
    for(let i = 0; i < str.length; i++){
        const c = str.charCodeAt(i)
        if(c !== 0 && c < 0x80){
            bytes.push(c)
        } else if(c < 0x800){
            bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F))
        } else {
            bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F))
        }
    }
    const len = Buffer.alloc(2)
    len.writeUInt16BE(bytes.length)
    return Buffer.concat([len, Buffer.from(bytes)])
}

function decodeString(raw){
    const units = []
    for(let i = 2; i < raw.length;){
        const b = raw[i]
        if(b < 0x80){
            units.push(b)
            i += 1
        } else if((b & 0xE0) === 0xC0){
            units.push(((b & 0x1F) << 6) | (raw[i + 1] & 0x3F))
            i += 2
        } else {
            units.push(((b & 0x0F) << 12) | ((raw[i + 1] & 0x3F) << 6) | (raw[i + 2] & 0x3F))
            i += 3
        }
    }
    return String.fromCharCode(...units)
}

/** Reads a payload of `type` at `offset`. Returns [value, nextOffset]. */
function readPayload(buf, type, offset){
    if(type === TAG_COMPOUND){
        const entries = []
        for(;;){
            const tagType = buf.readUInt8(offset++)
            if(tagType === TAG_END){
                return [entries, offset]
            }
            const nameLen = buf.readUInt16BE(offset)
            const name = decodeString(buf.subarray(offset, offset + 2 + nameLen))
            const [value, next] = readPayload(buf, tagType, offset + 2 + nameLen)
            entries.push({ type: tagType, name, value })
            offset = next
        }
    }
    if(type === TAG_LIST){
        const itemType = buf.readUInt8(offset)
        const count = buf.readInt32BE(offset + 1)
        offset += 5
        const items = []
        for(let i = 0; i < count; i++){
            const [value, next] = readPayload(buf, itemType, offset)
            items.push(value)
            offset = next
        }
        return [{ itemType, items }, offset]
    }
    const size = RAW_SIZE[type]
    if(size == null){
        throw new Error(`Unknown NBT tag type ${type}`)
    }
    const end = offset + size(buf, offset)
    return [buf.subarray(offset, end), end]
}

function writePayload(type, value){
    if(type === TAG_COMPOUND){
        return Buffer.concat([
            ...value.map(e => Buffer.concat([Buffer.from([e.type]), encodeString(e.name), writePayload(e.type, e.value)])),
            Buffer.from([TAG_END])
        ])
    }
    if(type === TAG_LIST){
        const head = Buffer.alloc(5)
        head.writeUInt8(value.itemType)
        head.writeInt32BE(value.items.length, 1)
        return Buffer.concat([head, ...value.items.map(item => writePayload(value.itemType, item))])
    }
    return value
}

/** host:25565 and host are the same server. */
function normalizeAddress(address){
    return address.trim().toLowerCase().replace(/:25565$/, '')
}

/**
 * Adds the server to servers.dat in gameDir (at the top) unless an entry with its address is already there.
 *
 * @param {string} gameDir The server's instance directory.
 * @param {string} name The name shown in the server list.
 * @param {string} address The server address (host or host:port).
 * @returns {boolean} Whether servers.dat was changed.
 */
exports.ensureServerListed = function(gameDir, name, address){
    const file = path.join(gameDir, 'servers.dat')

    let rootName = ''
    let root = []
    if(fs.existsSync(file)){
        const buf = fs.readFileSync(file)
        if(buf.readUInt8(0) !== TAG_COMPOUND){
            throw new Error('servers.dat does not start with a compound tag.')
        }
        const nameLen = buf.readUInt16BE(1)
        rootName = decodeString(buf.subarray(1, 3 + nameLen))
        root = readPayload(buf, TAG_COMPOUND, 3 + nameLen)[0]
    }

    let serversTag = root.find(e => e.name === 'servers' && e.type === TAG_LIST)
    if(serversTag == null){
        serversTag = { type: TAG_LIST, name: 'servers', value: { itemType: TAG_COMPOUND, items: [] } }
        root = root.filter(e => e.name !== 'servers')
        root.push(serversTag)
    }
    const list = serversTag.value
    if(list.items.length === 0){
        list.itemType = TAG_COMPOUND
    }
    if(list.itemType !== TAG_COMPOUND){
        throw new Error('servers.dat has an unexpected "servers" list.')
    }

    const target = normalizeAddress(address)
    const listed = list.items.some(entries => {
        const ip = entries.find(e => e.name === 'ip' && e.type === TAG_STRING)
        return ip != null && normalizeAddress(decodeString(ip.value)) === target
    })
    if(listed){
        return false
    }

    list.items.unshift([
        { type: TAG_STRING, name: 'name', value: encodeString(name) },
        { type: TAG_STRING, name: 'ip', value: encodeString(address) },
        { type: TAG_BYTE, name: 'hidden', value: Buffer.from([0]) }
    ])

    const out = Buffer.concat([Buffer.from([TAG_COMPOUND]), encodeString(rootName), writePayload(TAG_COMPOUND, root)])
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, out)
    fs.renameSync(tmp, file)
    return true
}

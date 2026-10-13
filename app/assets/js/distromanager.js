const { DistributionAPI } = require('helios-core/common')

const ConfigManager = require('./configmanager')
const { DISTRO_URL } = require('./hosting')

exports.REMOTE_DISTRO_URL = DISTRO_URL

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false
)

exports.DistroAPI = api

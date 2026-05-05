const path = require('path');
const rootDir = path.join(__dirname, '..');
const isDocker = process.env.RUNNING_IN_DOCKER === 'true' || process.env.RUNNING_IN_DOCKER === '1';
require('dotenv').config({ path: path.join(rootDir, '.env') });

function boolEnv(name, fallback) {
    const value = process.env[name];
    if (value === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function intEnv(name, fallback) {
    const value = parseInt(process.env[name], 10);
    return Number.isFinite(value) ? value : fallback;
}

module.exports = {
    server: {
        httpPort: intEnv('HTTP_PORT', 19000),
        httpsPort: intEnv('HTTPS_PORT', 19001),
        redirectToHttps: boolEnv('REDIRECT_TO_HTTPS', true),
        trustProxy: boolEnv('TRUST_PROXY', true)
    },
    ssl: {
        keyPath: isDocker ? (process.env.SSL_KEY_PATH || '/app/server/certs/key.pem') : path.join(__dirname, 'certs', 'key.pem'),
        certPath: isDocker ? (process.env.SSL_CERT_PATH || '/app/server/certs/cert.pem') : path.join(__dirname, 'certs', 'cert.pem')
    },
    session: {
        secret: process.env.SESSION_SECRET || 'change-this-session-secret',
        cookieSecure: boolEnv('SESSION_COOKIE_SECURE', true),
        maxAge: intEnv('SESSION_MAX_AGE_MS', 1000 * 60 * 60 * 8)
    },
    db: {
        host: process.env.DB_HOST || 'localhost',
        port: intEnv('DB_PORT', 3306),
        user: process.env.DB_USER || 'proctoring',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'proctoring_system',
        connectionLimit: intEnv('DB_CONNECTION_LIMIT', 10)
    },
    mediasoup: {
        complexNetworkMode: boolEnv('MEDIASOUP_COMPLEX_NETWORK_MODE', false),
        announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1',
        internalIp: process.env.MEDIASOUP_INTERNAL_IP || '0.0.0.0',
        internalSubnet: process.env.MEDIASOUP_INTERNAL_SUBNET || '192.168.100.',
        basePort: intEnv('MEDIASOUP_BASE_PORT', 40000),
        portsPerWorker: intEnv('MEDIASOUP_PORTS_PER_WORKER', 1000),
        maxWorkers: intEnv('MEDIASOUP_MAX_WORKERS', 1),
        reservedCpuCores: intEnv('MEDIASOUP_RESERVED_CPU_CORES', 2)
    },
    paths: {
        publicDir: path.join(rootDir, 'public'),
        viewsDir: path.join(rootDir, 'views'),
        recordingsDir: process.env.RECORDINGS_DIR || path.join(rootDir, 'public', 'recordings')
    }
};

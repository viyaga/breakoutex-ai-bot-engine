import dotenv from 'dotenv';

dotenv.config();

interface EnvConfig {
    port: number;
    mongoUri: string;
    cronSchedule: string;
    clientServerUrl: string;
    payloadUrl: string;
    payloadApiKey: string;
    serverIp: string;
}

const env: EnvConfig = {
    port: parseInt(process.env.PORT || '3001', 10),
    mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/express_api_db',
    cronSchedule: process.env.CRON_SCHEDULE || '*/5 * * * *',
    clientServerUrl: process.env.CLIENT_SERVER_URL || 'http://localhost:3000',
    payloadUrl: process.env.PAYLOAD_URL || 'http://localhost:4000',
    payloadApiKey: process.env.PAYLOAD_API_KEY || '',
    serverIp: process.env.SERVER_IP || '127.0.0.1'
};

export default env;